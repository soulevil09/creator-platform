// @vitest-environment node
// =============================================================================
// Server-side locale resolution, end to end (Session 10, D2 acceptance).
//
// These run against a REAL production Next server — `next build` then
// `next start` on a free port — because the property under test is about the
// bytes the server sends: with `Accept-Language: pt-BR` and no cookie, the
// first HTML payload must already be Portuguese (no client-side detection, no
// flash of the wrong language), and setting the cookie must change what the
// next request renders. Nothing short of an HTTP request proves that.
//
// The build goes to `.next-test` (via NEXT_DIST_DIR — see next.config.mjs), so
// it can never collide with `next build`'s `.next/` when Turborepo runs the
// `test` and `build` tasks for this package concurrently.
// =============================================================================
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCALE_COOKIE_NAME } from '@creator-platform/shared';
import en from '../../messages/en.json';
import ptBR from '../../messages/pt-BR.json';

const WEB_ROOT = resolve(__dirname, '../..');
const DIST_DIR = '.next-test';
const BUILD_TIMEOUT_MS = 240_000;

/**
 * The build inlines NEXT_PUBLIC_* values; pin the default so step 3 is
 * deterministic. NODE_ENV is pinned to `production` because Vitest exports
 * `test` to child processes, and a deployed `next build`/`next start` runs as
 * production — which is what the Session 12 header assertions (HSTS) are about.
 */
const buildEnv = {
  ...process.env,
  NODE_ENV: 'production' as const,
  NEXT_DIST_DIR: DIST_DIR,
  NEXT_PUBLIC_DEFAULT_LOCALE: 'pt-BR',
  NEXT_TELEMETRY_DISABLED: '1',
};

let server: ChildProcess | undefined;
let baseUrl = '';

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? done(port) : fail(new Error('no port'))));
    });
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Next server did not come up at ${url}`);
}

async function html(path: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`, { headers, redirect: 'manual' });
  expect(res.status).toBe(200);
  return res.text();
}

const lang = (page: string) => page.match(/<html[^>]*\slang="([^"]+)"/)?.[1];

beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'next', 'build'], {
    cwd: WEB_ROOT,
    env: buildEnv,
    stdio: 'pipe',
    timeout: BUILD_TIMEOUT_MS,
  });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: WEB_ROOT,
    env: buildEnv,
    stdio: 'ignore',
  });
  await waitForServer(`${baseUrl}/`, 60_000);
}, BUILD_TIMEOUT_MS + 60_000);

afterAll(() => {
  server?.kill();
});

describe('server-rendered locale', () => {
  it('Accept-Language: pt-BR and no cookie → the HTML payload is already Portuguese', async () => {
    const page = await html('/', { 'accept-language': 'pt-BR' });
    expect(lang(page)).toBe('pt-BR');
    expect(page).toContain(`<title>${ptBR.metadata.title}</title>`);
    expect(page).toContain(ptBR.home.tagline);
    expect(page).toContain(ptBR.home.comingSoon);
    expect(page).not.toContain(en.home.tagline);
  });

  it('Accept-Language: en and no cookie → English', async () => {
    const page = await html('/', { 'accept-language': 'en-US,en;q=0.9,pt;q=0.5' });
    expect(lang(page)).toBe('en');
    expect(page).toContain(`<title>${en.metadata.title}</title>`);
    expect(page).toContain(en.home.tagline);
    expect(page).not.toContain(ptBR.home.tagline);
  });

  it('setting the cookie changes the rendered text on the next navigation, over the header', async () => {
    const before = await html('/', { 'accept-language': 'pt-BR' });
    expect(before).toContain(ptBR.home.tagline);

    const after = await html('/', {
      'accept-language': 'pt-BR',
      cookie: `${LOCALE_COOKIE_NAME}=en`,
    });
    expect(lang(after)).toBe('en');
    expect(after).toContain(en.home.tagline);
    expect(after).not.toContain(ptBR.home.tagline);

    // And back again — the cookie is the whole state; the URL never changes.
    const back = await html('/', {
      'accept-language': 'en',
      cookie: `${LOCALE_COOKIE_NAME}=pt-BR`,
    });
    expect(lang(back)).toBe('pt-BR');
    expect(back).toContain(ptBR.home.tagline);
  });

  it('a tampered cookie falls through to the header, and no header falls through to the default', async () => {
    const tampered = await html('/', {
      'accept-language': 'en',
      cookie: `${LOCALE_COOKIE_NAME}=${encodeURIComponent('../../etc/passwd')}`,
    });
    expect(lang(tampered)).toBe('en');
    expect(tampered).not.toContain('passwd');

    const bare = await html('/');
    expect(lang(bare)).toBe('pt-BR');
    expect(bare).toContain(ptBR.home.tagline);
  });

  it("client components render in the same locale, and only that locale's catalog is shipped", async () => {
    const page = await html('/wallet', { cookie: `${LOCALE_COOKIE_NAME}=en` });
    expect(lang(page)).toBe('en');
    // A client-component string, server-rendered in English…
    expect(page).toContain(en.wallet.balanceHeading);
    // …with the English catalog serialised for hydration and the Portuguese
    // one nowhere in the payload.
    expect(page).toContain(en.wallet.status.signInRequired);
    expect(page).not.toContain(ptBR.wallet.balanceHeading);
    expect(page).not.toContain(ptBR.wallet.status.signInRequired);
  });
});

// ── Session 12, D5 — per-request CSP nonce on the production server ─────────
describe('security headers on a production `next start` response', () => {
  const nonceOf = (csp: string | null) => csp?.match(/'nonce-([^']+)'/)?.[1];

  it('carries a nonce CSP, and every <script> in the HTML carries that same nonce', async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { 'accept-language': 'en' } });
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy');
    const nonce = nonceOf(csp);
    expect(nonce).toBeTruthy();
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");

    const page = await res.text();
    const scripts = page.match(/<script\b[^>]*>/g) ?? [];
    const inline = scripts.filter((tag) => !/\ssrc=/.test(tag));
    expect(inline.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
    // The locale behaviour is unchanged by the proxy.
    expect(lang(page)).toBe('en');
  });

  it('mints a different nonce per request', async () => {
    const a = nonceOf((await fetch(`${baseUrl}/`)).headers.get('content-security-policy'));
    const b = nonceOf((await fetch(`${baseUrl}/`)).headers.get('content-security-policy'));
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('sends the static security headers, HSTS included (production)', async () => {
    const res = await fetch(`${baseUrl}/wallet`, {
      headers: { cookie: `${LOCALE_COOKIE_NAME}=pt-BR` },
    });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(lang(await res.text())).toBe('pt-BR');
  });
});

// ── Session 12.6, D3 — the Image Optimization API is closed ─────────────────
describe('`/_next/image` on a production `next start` server', () => {
  it('answers 4xx with no image, because `images.unoptimized` removes the optimizer', async () => {
    const res = await fetch(`${baseUrl}/_next/image?url=%2Ffavicon.ico&w=64&q=75`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get('content-type') ?? '').not.toMatch(/^image\//);
    // 404, not the optimizer's own 400: with the optimizer enabled, a missing
    // source (this app ships no favicon) is a 400 — so only a 404 shows the
    // route itself is gone rather than the input being rejected.
    expect(res.status).toBe(404);
  });
});
