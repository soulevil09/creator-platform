// =============================================================================
// Deployment smoke test (Session 13, D9). Zero dependencies; Node 22.6+:
//
//   node --experimental-strip-types scripts/smoke.ts \
//     --app-url https://app.visorfans.com --api-url https://api.visorfans.com
//
// Local stack (infra/local/up.sh), no DNS, self-signed/internal certificates:
//
//   node --experimental-strip-types scripts/smoke.ts \
//     --app-url https://app.visorfans.test --api-url https://api.visorfans.test \
//     --resolve 127.0.0.1 --insecure-tls
//
// --resolve <ip>   connect every request to <ip> (like curl --resolve), and use
//                  it as the droplet address for the unknown-Host checks.
//                  Default: the api host's DNS A record (DNS-only in Cloudflare,
//                  so it IS the droplet).
// --insecure-tls   skip certificate validation (local only); the TLS-validity
//                  checks are then reported as SKIP, never as PASS.
//
// Output is status codes and header names only — never a body, cookie, token
// or secret (it holds none: every request is anonymous). Exit 1 on any FAIL.
// =============================================================================
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'app-url': { type: 'string' },
    'api-url': { type: 'string' },
    resolve: { type: 'string' },
    'insecure-tls': { type: 'boolean', default: false },
  },
});
if (!values['app-url'] || !values['api-url']) {
  console.error(
    'usage: smoke.ts --app-url <https://…> --api-url <https://…> [--resolve <ip>] [--insecure-tls]',
  );
  process.exit(2);
}
const APP = new URL(values['app-url']);
const API = new URL(values['api-url']);
const INSECURE = values['insecure-tls'] ?? false;
const TIMEOUT_MS = 10_000;

let failures = 0;
function report(status: 'PASS' | 'FAIL' | 'SKIP', name: string, detail = ''): void {
  if (status === 'FAIL') failures += 1;
  console.log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name: string, run: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await run();
    report('PASS', name, detail ?? '');
  } catch (err) {
    report('FAIL', name, err instanceof Error ? err.message : String(err));
  }
}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const dropletIp = values.resolve ?? (await dnsLookup(API.hostname, { family: 4 })).address;
/** Pin every connection to `--resolve` when given (curl --resolve semantics). */
const pinnedLookup: net.LookupFunction | undefined = values.resolve
  ? (_host, options, callback) => {
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(
          null,
          [{ address: dropletIp, family: 4 }],
        );
      } else callback(null, dropletIp, 4);
    }
  : undefined;

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  url: URL,
  init: { method?: string; headers?: Record<string, string>; body?: string; verify?: boolean } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers,
        lookup: pinnedLookup,
        rejectUnauthorized: init.verify ?? !INSECURE,
        timeout: TIMEOUT_MS,
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

const at = (base: URL, path: string) => new URL(path, base);
const json = { 'content-type': 'application/json' };

// ── API liveness / readiness ─────────────────────────────────────────────────
await check('api GET /health → 200', async () => {
  const res = await request(at(API, '/health'));
  expect(res.status === 200, `got ${res.status}`);
});
await check('api GET /health/ready → 200 (database reachable)', async () => {
  const res = await request(at(API, '/health/ready'));
  expect(res.status === 200, `got ${res.status}`);
});

// ── TLS ──────────────────────────────────────────────────────────────────────
for (const host of [API, APP]) {
  const name = `valid TLS certificate on ${host.hostname}`;
  if (INSECURE) {
    report('SKIP', name, '--insecure-tls (local stack: internal CA / self-signed origin cert)');
    continue;
  }
  await check(name, async () => {
    const days = await new Promise<number>((resolve, reject) => {
      const socket = tls.connect(
        { host: dropletIp, port: 443, servername: host.hostname, rejectUnauthorized: true },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          resolve(Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000));
        },
      );
      socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('timeout')));
      socket.on('error', reject);
    });
    expect(days >= 7, `certificate expires in ${days} days`);
    return `${days} days left`;
  });
}

// ── HTTP → HTTPS ─────────────────────────────────────────────────────────────
for (const host of [API, APP]) {
  await check(`http://${host.hostname} redirects to https`, async () => {
    const res = await request(new URL(`http://${host.hostname}/`));
    expect([301, 302, 307, 308].includes(res.status), `got ${res.status}`);
    expect(String(res.headers.location).startsWith('https://'), 'Location is not https');
  });
}

// ── API headers ──────────────────────────────────────────────────────────────
await check('api security headers (helmet + CORP same-site), no fingerprints', async () => {
  const { headers } = await request(at(API, '/health'));
  expect(headers['content-security-policy']?.includes("default-src 'none'"), 'CSP missing');
  expect(headers['x-content-type-options'] === 'nosniff', 'nosniff missing');
  expect(headers['x-frame-options'] === 'DENY', 'X-Frame-Options missing');
  expect(headers['referrer-policy'] === 'no-referrer', 'Referrer-Policy missing');
  expect(headers['cross-origin-resource-policy'] === 'same-site', 'CORP is not same-site');
  expect(headers['strict-transport-security'], 'HSTS missing');
  for (const banned of ['server', 'x-powered-by', 'via']) {
    expect(!(banned in headers), `${banned} header present`);
  }
});

// ── Web ──────────────────────────────────────────────────────────────────────
await check('app GET / → 200 with a nonce CSP and no unsafe-inline scripts', async () => {
  const res = await request(at(APP, '/'));
  expect(res.status === 200, `got ${res.status}`);
  const csp = String(res.headers['content-security-policy'] ?? '');
  const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
  expect(/'nonce-[A-Za-z0-9+/=]+'/.test(scriptSrc), 'script-src has no nonce');
  expect(!scriptSrc.includes("'unsafe-inline'"), "script-src allows 'unsafe-inline'");
  expect(!scriptSrc.includes("'unsafe-eval'"), "script-src allows 'unsafe-eval'");
  for (const banned of ['server', 'x-powered-by', 'via']) {
    expect(!(banned in res.headers), `${banned} header present`);
  }
});
await check('app /_next/image is not served', async () => {
  const res = await request(at(APP, '/_next/image?url=%2Ffavicon.ico&w=64&q=75'));
  expect(res.status === 404, `got ${res.status}`);
});

// ── Disabled channels / closed doors ─────────────────────────────────────────
for (const path of ['/api/payments/woovi/webhook', '/api/payouts/paxum/webhook']) {
  await check(`disabled webhook POST ${path} → 404`, async () => {
    const res = await request(at(API, path), { method: 'POST', headers: json, body: '{}' });
    expect(res.status === 404, `got ${res.status}`);
  });
}
await check('cron route without its secret → 401', async () => {
  // No body and no Content-Type, exactly like the cron workflows.
  const res = await request(at(API, '/api/subscriptions/renewals/run'), { method: 'POST' });
  expect(res.status === 401, `got ${res.status}`);
});
await check('POST /api/auth/register → 503 registration_unavailable (email disabled)', async () => {
  const res = await request(at(API, '/api/auth/register'), {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      email: `smoke-${Date.now()}@example.invalid`,
      password: 'smoke-test-password',
      displayName: 'Smoke',
      role: 'subscriber',
    }),
  });
  expect(res.status === 503, `got ${res.status}`);
  expect(res.body.includes('registration_unavailable'), 'unexpected error code');
});

// ── Unknown Host against the droplet address ─────────────────────────────────
await check(
  `unknown Host over HTTP to ${values.resolve ? '--resolve' : 'droplet'} IP → no site`,
  async () => {
    const outcome = await new Promise<string>((resolve) => {
      const req = http.request(
        {
          host: dropletIp,
          port: 80,
          path: '/',
          headers: { host: 'unknown.invalid' },
          timeout: TIMEOUT_MS,
        },
        (res) => resolve(`answered ${res.statusCode}`),
      );
      req.on('error', (err) =>
        resolve(`aborted (${(err as NodeJS.ErrnoException).code ?? err.message})`),
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
    expect(outcome.startsWith('aborted'), outcome);
    return outcome;
  },
);
await check('unknown SNI over HTTPS → no certificate / handshake refused', async () => {
  const outcome = await new Promise<string>((resolve) => {
    const socket = tls.connect(
      { host: dropletIp, port: 443, servername: 'unknown.invalid', rejectUnauthorized: false },
      () => {
        socket.end();
        resolve('handshake completed');
      },
    );
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('timeout')));
    socket.on('error', (err) =>
      resolve(`refused (${(err as NodeJS.ErrnoException).code ?? err.message})`),
    );
  });
  expect(outcome.startsWith('refused'), outcome);
  return outcome;
});

console.log(failures === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
