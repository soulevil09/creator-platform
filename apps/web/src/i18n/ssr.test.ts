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

/** The build inlines NEXT_PUBLIC_* values; pin the default so step 3 is deterministic. */
const buildEnv = {
  ...process.env,
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
