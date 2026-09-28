// @vitest-environment node
// Unit tests for the CSP builder (Session 12, D5). The end-to-end property —
// a real `next start` response whose scripts all carry the header's nonce —
// is asserted in src/i18n/ssr.test.ts against a production build.
import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, createNonce } from './csp';

const directive = (csp: string, name: string) =>
  csp
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.split(' ')
    .slice(1) ?? [];

describe('buildContentSecurityPolicy', () => {
  const base = {
    nonce: 'abc123==',
    apiUrl: 'https://api.example.com/some/path',
    mediaOrigin: 'https://media.example.com',
  };

  it('production: nonce + strict-dynamic, no unsafe-eval, no unsafe-inline for scripts', () => {
    const csp = buildContentSecurityPolicy({ ...base, isDev: false });
    expect(directive(csp, 'script-src')).toEqual([
      "'self'",
      "'nonce-abc123=='",
      "'strict-dynamic'",
    ]);
    expect(csp).not.toContain('unsafe-eval');
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('development adds unsafe-eval to script-src only', () => {
    const csp = buildContentSecurityPolicy({ ...base, isDev: true });
    expect(directive(csp, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('connect/img/media sources are self + the API origin (+ its wss twin) + the media origin', () => {
    const csp = buildContentSecurityPolicy({ ...base, isDev: false });
    expect(directive(csp, 'connect-src')).toEqual([
      "'self'",
      'https://api.example.com',
      'wss://api.example.com',
    ]);
    for (const name of ['img-src', 'media-src']) {
      expect(directive(csp, name)).toEqual([
        "'self'",
        'data:',
        'blob:',
        'https://api.example.com',
        'https://media.example.com',
      ]);
    }
  });

  it('http API origins get a ws: twin, and unset/invalid origins are simply omitted', () => {
    const local = buildContentSecurityPolicy({
      nonce: 'n',
      isDev: false,
      apiUrl: 'http://localhost:4000',
    });
    expect(directive(local, 'connect-src')).toEqual([
      "'self'",
      'http://localhost:4000',
      'ws://localhost:4000',
    ]);
    const bare = buildContentSecurityPolicy({
      nonce: 'n',
      isDev: false,
      apiUrl: 'not a url',
      mediaOrigin: 'javascript:alert(1)',
    });
    expect(directive(bare, 'connect-src')).toEqual(["'self'"]);
    expect(directive(bare, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('locks framing, plugins and base/form targets', () => {
    const csp = buildContentSecurityPolicy({ ...base, isDev: false });
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
    expect(directive(csp, 'form-action')).toEqual(["'self'"]);
  });
});

describe('createNonce', () => {
  it('is 128 bits of base64 and differs per call', () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(a).not.toBe(b);
  });
});
