// =============================================================================
// Bundle smoke check (Session 13, D6) — run by CI after `pnpm turbo run build`.
//
// A bundle that typechecks and passes the suite can still fail to START (an
// import esbuild left external that the runtime cannot resolve, a top-level
// throw). That must fail CI, not the deploy. So this:
//
//   1. boots `dist/index.js` with a minimal throwaway env (every provider at
//      its `disabled` default, a database URL that points nowhere) from a
//      neutral working directory, so no local `.env` is picked up;
//   2. requires `GET /health` → 200 within the timeout;
//   3. requires `node dist/scripts/ops/create-user.js --help` → exit 0.
//
// No secret here is real; nothing listens beyond 127.0.0.1.
// =============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const API_ROOT = resolve(import.meta.dirname, '..');
const PORT = 4987;
const TIMEOUT_MS = 20_000;

const env = {
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  API_PORT: String(PORT),
  JWT_SECRET: 'bundle-check-access-secret-0123456789',
  JWT_REFRESH_SECRET: 'bundle-check-refresh-secret-0123456789',
  WATERMARK_TRACE_SECRET: 'bundle-check-trace-secret-0123456789',
  STORAGE_ENDPOINT: 'http://127.0.0.1:9/storage',
  STORAGE_BUCKET: 'bundle-check',
  STORAGE_ACCESS_KEY: 'bundle-check',
  STORAGE_SECRET_KEY: 'bundle-check',
  DATABASE_URL: 'postgresql://bundle:check@127.0.0.1:9/none',
};
const cwd = mkdtempSync(join(tmpdir(), 'api-bundle-check-'));

function fail(message) {
  console.error(`[check-bundle] FAIL: ${message}`);
  process.exitCode = 1;
}

const server = spawn(process.execPath, [join(API_ROOT, 'dist/index.js')], {
  cwd,
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
server.stderr.on('data', (chunk) => (stderr += chunk));
let exited = false;
server.on('exit', () => (exited = true));

try {
  const deadline = Date.now() + TIMEOUT_MS;
  let status = 0;
  while (Date.now() < deadline && !exited) {
    try {
      status = (await fetch(`http://127.0.0.1:${PORT}/health`)).status;
      if (status === 200) break;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (status === 200) console.log('[check-bundle] dist/index.js: GET /health → 200');
  else fail(`dist/index.js did not answer /health with 200 (last: ${status})\n${stderr}`);
} finally {
  server.kill('SIGTERM');
}

const cli = spawnSync(
  process.execPath,
  [join(API_ROOT, 'dist/scripts/ops/create-user.js'), '--help'],
  { cwd, env, encoding: 'utf8' },
);
if (cli.status === 0 && cli.stdout.includes('Usage: create-user')) {
  console.log('[check-bundle] dist/scripts/ops/create-user.js --help → exit 0');
} else {
  fail(`create-user --help exited ${cli.status}\n${cli.stderr}`);
}
