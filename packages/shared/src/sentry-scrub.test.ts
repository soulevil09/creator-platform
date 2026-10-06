// Sentry PII scrubber (Session 13, D3): a realistic event carrying every
// forbidden field goes in; none of them may come out.
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubString,
  stripQuery,
} from './sentry-scrub';

const SIGNED_URL =
  'https://abc.supabase.co/storage/v1/s3/bucket/content/m1/x.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=deadbeef';

/** Everything the scrubber must remove, as distinct needles. */
const SECRETS = {
  password: 'hunter2-hunter2',
  email: 'victim@example.com',
  payoutEmail: 'paxum-account@example.org',
  cookie: 'access_token=eyJhbGciOiJIUzI1NiJ9.payload.sig',
  bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.other.sig',
  signature: 'b64-woovi-signature==',
  nowSig: 'hex-nowpayments-sig',
  cronSecret: 'cron-secret-value-123',
  xff: '203.0.113.99',
  ip: '198.51.100.23',
  verifyToken: 'f00dfacecafebeef',
  amz: 'X-Amz-Signature=deadbeef',
  storageKey: 'content/m1/secret-object.jpg',
  prompt: 'ANCHOR: photorealistic portrait of model_123',
  body: 'private message body',
};

function realisticEvent() {
  return {
    event_id: 'e1',
    level: 'error',
    message: `Failed for ${SECRETS.email} fetching ${SIGNED_URL}`,
    transaction: `GET /verify-email?token=${SECRETS.verifyToken}`,
    request: {
      method: 'POST',
      url: `https://api.visorfans.com/api/auth/verify-email?token=${SECRETS.verifyToken}`,
      query_string: `token=${SECRETS.verifyToken}`,
      data: { email: SECRETS.email, password: SECRETS.password, text: SECRETS.body },
      cookies: { access_token: SECRETS.cookie },
      env: { REMOTE_ADDR: SECRETS.ip },
      headers: {
        Cookie: SECRETS.cookie,
        'set-cookie': SECRETS.cookie,
        Authorization: SECRETS.bearer,
        'x-webhook-signature': SECRETS.signature,
        'x-nowpayments-sig': SECRETS.nowSig,
        'x-paxum-signature': SECRETS.signature,
        'x-payout-cron-secret': SECRETS.cronSecret,
        'x-reconciliation-cron-secret': SECRETS.cronSecret,
        'x-forwarded-for': SECRETS.xff,
        'x-real-ip': SECRETS.ip,
        'user-agent': 'curl/8.0',
        referer: `https://app.visorfans.com/wallet?token=${SECRETS.verifyToken}`,
      },
    },
    user: { id: 'u_1', email: SECRETS.email, ip_address: SECRETS.ip, username: SECRETS.email },
    extra: {
      payoutEmail: SECRETS.payoutEmail,
      storageKey: SECRETS.storageKey,
      anchorPrompt: SECRETS.prompt,
      nested: { deeper: { contact: `mail me at ${SECRETS.email}` } },
      apiKey: 'r8_secret',
      count: 3,
    },
    contexts: {
      payment: { idempotencyKey: 'sub_abc', webhookSecret: SECRETS.signature },
      trace: { trace_id: 't', span_id: 's' },
    },
    tags: { route: '/api/x', userEmail: SECRETS.email },
    exception: {
      values: [
        {
          type: 'Error',
          value: `upload failed: ${SIGNED_URL} for ${SECRETS.email}`,
          stacktrace: {
            frames: [
              {
                function: 'f',
                vars: { password: SECRETS.password, n: 1 },
                pre_context: [`const who = '${SECRETS.email}';`],
                context_line: `fetch('${SIGNED_URL}')`,
                post_context: [`// ${SECRETS.email}`],
              },
            ],
          },
        },
      ],
    },
    breadcrumbs: [
      {
        category: 'http',
        message: `GET ${SIGNED_URL}`,
        data: { url: SIGNED_URL, method: 'GET', status_code: 500 },
      },
      {
        category: 'navigation',
        data: { from: '/a?token=x', to: `/verify-email?token=${SECRETS.verifyToken}` },
      },
    ],
    spans: [
      {
        description: `GET ${SIGNED_URL}`,
        data: { 'http.url': SIGNED_URL, 'url.full': SIGNED_URL, prompt: SECRETS.prompt },
      },
    ],
  };
}

describe('scrubSentryEvent', () => {
  it('no forbidden value survives anywhere in the event', () => {
    const serialized = JSON.stringify(scrubSentryEvent(realisticEvent()));
    for (const [name, needle] of Object.entries(SECRETS)) {
      expect(serialized, `${name} leaked`).not.toContain(needle);
    }
    expect(serialized).not.toMatch(/X-Amz-/);
    expect(serialized).not.toMatch(/[?&]token=/);
  });

  it('drops request bodies, cookies, query strings and env entirely', () => {
    const { request } = scrubSentryEvent(realisticEvent()) as { request: Record<string, unknown> };
    expect(request).not.toHaveProperty('data');
    expect(request).not.toHaveProperty('cookies');
    expect(request).not.toHaveProperty('query_string');
    expect(request).not.toHaveProperty('env');
    expect(request.url).toBe('https://api.visorfans.com/api/auth/verify-email');
    expect(request.method).toBe('POST');
  });

  it('removes the sensitive headers by name, keeps harmless ones', () => {
    const { request } = scrubSentryEvent(realisticEvent()) as {
      request: { headers: Record<string, string> };
    };
    expect(Object.keys(request.headers).sort()).toEqual(['referer', 'user-agent']);
    expect(request.headers.referer).toBe('https://app.visorfans.com/wallet');
  });

  it('keeps only the user id', () => {
    expect(scrubSentryEvent(realisticEvent()).user).toEqual({ id: 'u_1' });
    expect(scrubSentryEvent({ user: { email: 'a@b.co' } })).not.toHaveProperty('user');
  });

  it('redacts sensitive keys and email-shaped strings in extra/contexts/tags', () => {
    const event = scrubSentryEvent(realisticEvent()) as ReturnType<typeof realisticEvent>;
    expect(event.extra.payoutEmail).toBe(REDACTED);
    expect(event.extra.storageKey).toBe(REDACTED);
    expect(event.extra.anchorPrompt).toBe(REDACTED);
    expect(event.extra.apiKey).toBe(REDACTED);
    expect(event.extra.count).toBe(3);
    expect(event.extra.nested.deeper.contact).toBe(`mail me at ${REDACTED}`);
    expect(event.contexts.payment.idempotencyKey).toBe(REDACTED);
    expect(event.contexts.trace).toEqual({ trace_id: 't', span_id: 's' });
    expect(event.tags.route).toBe('/api/x');
  });

  it('works as beforeSendTransaction: span URLs and data are scrubbed', () => {
    const event = scrubSentryEvent({ type: 'transaction', ...realisticEvent() });
    const span = (event as { spans: Array<{ description: string; data: Record<string, string> }> })
      .spans[0];
    expect(span.description).toBe(
      'GET https://abc.supabase.co/storage/v1/s3/bucket/content/m1/x.jpg',
    );
    expect(span.data['http.url']).not.toContain('?');
    expect(span.data.prompt).toBe(REDACTED);
  });

  it('does not mutate its input', () => {
    const input = realisticEvent();
    const before = JSON.stringify(input);
    scrubSentryEvent(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('scrubSentryBreadcrumb', () => {
  it('strips URL queries from data and message, keeps the rest', () => {
    const crumb = scrubSentryBreadcrumb({
      category: 'fetch',
      message: `POST /api/auth/login?next=/x by ${SECRETS.email}`,
      data: { url: SIGNED_URL, method: 'POST', status_code: 401 },
    });
    expect(crumb).toEqual({
      category: 'fetch',
      message: `POST /api/auth/login by ${REDACTED}`,
      data: {
        url: 'https://abc.supabase.co/storage/v1/s3/bucket/content/m1/x.jpg',
        method: 'POST',
        status_code: 401,
      },
    });
  });
});

describe('string helpers', () => {
  it('stripQuery handles absolute URLs, paths and fragments', () => {
    expect(stripQuery('/a/b?c=1#d')).toBe('/a/b');
    expect(stripQuery('https://x.test/a#frag')).toBe('https://x.test/a');
    expect(stripQuery('/plain')).toBe('/plain');
  });

  it('scrubString removes queries inside free text', () => {
    expect(scrubString(`see ${SIGNED_URL} and (/verify-email?token=abc)`)).toBe(
      'see https://abc.supabase.co/storage/v1/s3/bucket/content/m1/x.jpg and (/verify-email)',
    );
  });
});
