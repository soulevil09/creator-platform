// @vitest-environment node
// Sentry tunnel policy (Session 13, D3): forwards our project only.
import { describe, expect, it } from 'vitest';
import { TUNNEL_MAX_BYTES, decideTunnel, tunnelTarget } from './sentry-tunnel';

const OURS = 'https://abc123@o4500000000000001.ingest.us.sentry.io/4500000000000002';
const ours = tunnelTarget(OURS);

const envelope = (dsn: unknown, item = '{"type":"event"}\n{}') =>
  `${JSON.stringify({ event_id: 'e', dsn })}\n${item}`;

describe('tunnelTarget', () => {
  it('derives the ingest URL from our DSN', () => {
    expect(ours).toEqual({
      url: 'https://o4500000000000001.ingest.us.sentry.io/api/4500000000000002/envelope/',
      host: 'o4500000000000001.ingest.us.sentry.io',
      projectId: '4500000000000002',
      publicKey: 'abc123',
    });
  });

  it('rejects anything that is not an https DSN with a key and a numeric project', () => {
    expect(tunnelTarget(undefined)).toBeNull();
    expect(tunnelTarget('')).toBeNull();
    expect(tunnelTarget('http://k@o1.ingest.sentry.io/2')).toBeNull();
    expect(tunnelTarget('https://o1.ingest.sentry.io/2')).toBeNull();
    expect(tunnelTarget('https://k@o1.ingest.sentry.io/abc')).toBeNull();
  });
});

describe('decideTunnel', () => {
  it('forwards an envelope for our DSN to our ingest URL', () => {
    expect(decideTunnel(ours, envelope(OURS))).toEqual({ ok: true, forwardTo: ours!.url });
  });

  it('is not an open relay: another project, org or key is refused', () => {
    for (const other of [
      'https://abc123@o4500000000000001.ingest.us.sentry.io/999',
      'https://abc123@o999.ingest.us.sentry.io/4500000000000002',
      'https://other@o4500000000000001.ingest.us.sentry.io/4500000000000002',
      'https://abc123@evil.example/4500000000000002',
    ]) {
      expect(decideTunnel(ours, envelope(other))).toEqual({ ok: false, status: 400 });
    }
  });

  it('the destination never comes from the request', () => {
    const decision = decideTunnel(ours, envelope(OURS));
    expect(decision.ok && decision.forwardTo).toBe(
      'https://o4500000000000001.ingest.us.sentry.io/api/4500000000000002/envelope/',
    );
  });

  it('refuses malformed headers and missing DSNs', () => {
    expect(decideTunnel(ours, 'not json\n{}')).toEqual({ ok: false, status: 400 });
    expect(decideTunnel(ours, envelope(undefined))).toEqual({ ok: false, status: 400 });
  });

  it('refuses oversized envelopes', () => {
    const big = envelope(OURS, 'x'.repeat(TUNNEL_MAX_BYTES));
    expect(decideTunnel(ours, big)).toEqual({ ok: false, status: 413 });
  });

  it('without a configured DSN the tunnel does not exist (404)', () => {
    expect(decideTunnel(null, envelope(OURS))).toEqual({ ok: false, status: 404 });
  });
});
