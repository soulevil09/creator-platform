// =============================================================================
// Load-test baseline (Session 12, D8) — reproducible, operator-run, not in CI.
//
//   pnpm --filter @creator-platform/api load             # full run (needs a DB)
//   pnpm --filter @creator-platform/api load --dry-run   # GET /health only, no DB
//
// Boots the real `buildServer` in-process with every external provider on its
// mock adapter (AI_PROVIDER / PAYMENT_PROVIDER_* / PAYOUT_PROVIDER = mock),
// listens on an ephemeral 127.0.0.1 port, and drives it with autocannon.
// The database is whatever DATABASE_URL the operator supplies.
//
// Why autocannon over k6: it is an npm devDependency (no external binary to
// install on a laptop or runner), is driven from the same TypeScript toolchain
// as the API, and can boot the server in the same process.
//
// Safety:
//   * refuses to run when NODE_ENV=production;
//   * refuses when DATABASE_URL's host matches LOAD_TEST_FORBIDDEN_HOSTS
//     (comma-separated; exact host or a `.suffix` match);
//   * the full run seeds uniquely-tagged users/content and deletes them again
//     in a `finally`, whatever happens.
//
// Rate limits are NOT disabled. Every scenario is sized to stay inside its
// own budget (the login IP limit, the IP limits on the anonymous listing and
// the wallet read) or is spread across several seeded users (the per-user
// messaging read). Any 429 that still happens is counted separately.
//
// The server runs with NODE_ENV=test inside this process: that is the switch
// that stops src/index.ts from auto-listening on API_PORT, and it also turns
// off per-request logging, which would otherwise dominate the latencies.
// =============================================================================
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, '../../../../docs/performance/load-baseline.md');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Guards ───────────────────────────────────────────────────────────────────
function databaseHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostIsForbidden(host: string, denylist: string | undefined): boolean {
  const entries = (denylist ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.some((entry) => (entry.startsWith('.') ? host.endsWith(entry) : host === entry));
}

function refuse(reason: string): never {
  console.error(`[load] refusing to run: ${reason}`);
  process.exit(2);
}

if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
  refuse('NODE_ENV=production');
}
const dbHost = databaseHost(process.env.DATABASE_URL);
if (dbHost && hostIsForbidden(dbHost, process.env.LOAD_TEST_FORBIDDEN_HOSTS)) {
  refuse(`DATABASE_URL host "${dbHost}" is in LOAD_TEST_FORBIDDEN_HOSTS`);
}
if (!DRY_RUN && !dbHost) {
  refuse('DATABASE_URL is not set (use --dry-run for the /health-only mode)');
}

// Every external provider on its mock adapter; set before the server module
// (and its eager env validation) is imported.
process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'mock';
process.env.PAYMENT_PROVIDER_PIX = 'mock';
process.env.PAYMENT_PROVIDER_CRYPTO = 'mock';
process.env.PAYMENT_PROVIDER_CARD = 'mock';
process.env.PAYOUT_PROVIDER = 'mock';
// The dry run never touches the database; a placeholder keeps the Prisma
// client constructible when no DATABASE_URL is configured at all.
process.env.DATABASE_URL ??= 'postgresql://load:dry-run@127.0.0.1:1/none';

// ── Scenario plumbing ────────────────────────────────────────────────────────
interface ScenarioResult {
  name: string;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  ok2xx: number;
  rateLimited429: number;
  otherNon2xx: number;
  note: string;
}

interface Scenario {
  name: string;
  path: string;
  method?: 'GET' | 'POST';
  /** Fixed request count (sized to a rate-limit budget) … */
  amount?: number;
  /** … or a fixed duration in seconds for unlimited routes. */
  duration?: number;
  connections: number;
  headers?: Record<string, string>;
  body?: string;
  /** Called per request, e.g. to rotate the caller's cookie. */
  perRequestHeaders?: () => Record<string, string>;
  note: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
}

async function runScenario(baseUrl: string, scenario: Scenario): Promise<ScenarioResult> {
  const latencies: number[] = [];
  let ok2xx = 0;
  let rateLimited429 = 0;
  let otherNon2xx = 0;

  let finish!: (result: autocannon.Result) => void;
  let fail!: (err: unknown) => void;
  const done = new Promise<autocannon.Result>((ok, ko) => {
    finish = ok;
    fail = ko;
  });
  // The callback form is the one whose return value is the event emitter.
  const instance = autocannon(
    {
      url: `${baseUrl}${scenario.path}`,
      method: scenario.method ?? 'GET',
      connections: scenario.connections,
      ...(scenario.amount !== undefined ? { amount: scenario.amount } : {}),
      ...(scenario.duration !== undefined ? { duration: scenario.duration } : {}),
      headers: scenario.headers,
      body: scenario.body,
      requests: scenario.perRequestHeaders
        ? [
            {
              setupRequest: (request) => ({
                ...request,
                headers: { ...request.headers, ...scenario.perRequestHeaders!() },
              }),
            },
          ]
        : undefined,
    },
    (err, result) => (err ? fail(err) : finish(result)),
  );
  instance.on('response', (_client, statusCode, _bytes, responseTime) => {
    latencies.push(responseTime);
    if (statusCode >= 200 && statusCode < 300) ok2xx += 1;
    else if (statusCode === 429) rateLimited429 += 1;
    else otherNon2xx += 1;
  });
  const result = await done;

  latencies.sort((a, b) => a - b);
  const seconds = Math.max(result.duration, 0.001);
  return {
    name: scenario.name,
    requests: latencies.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    rps: latencies.length / seconds,
    ok2xx,
    rateLimited429,
    otherNon2xx,
    note: scenario.note,
  };
}

// ── Seed + cleanup (full run only) ───────────────────────────────────────────
interface Seeded {
  runTag: string;
  userIds: string[];
  contentIds: string[];
  conversationIds: string[];
  modelId: string;
  loginEmail: string;
  loginPassword: string;
  subscriberCookies: string[];
}

const SUBSCRIBERS = 5;
const CONTENT_ITEMS = 20;

async function seed(
  prisma: import('../../src/lib/prisma.js').PrismaClient,
  signAccess: (payload: { userId: string; role: 'subscriber' | 'model' }) => string,
): Promise<Seeded> {
  const bcrypt = (await import('bcryptjs')).default;
  const runTag = `loadtest-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const email = (who: string) => `${runTag}+${who}@example.invalid`;
  const loginPassword = randomUUID();
  const userIds: string[] = [];

  const base = { isVerified: true, displayName: runTag, preferredLocale: 'en' };
  const loginUser = await prisma.user.create({
    data: {
      ...base,
      email: email('login'),
      // Cost 12, like every real password: the login scenario is the
      // bcrypt-bound worst case on purpose.
      passwordHash: await bcrypt.hash(loginPassword, 12),
      role: 'SUBSCRIBER',
    },
  });
  userIds.push(loginUser.id);

  const model = await prisma.user.create({
    data: { ...base, email: email('model'), passwordHash: 'x', role: 'MODEL' },
  });
  userIds.push(model.id);

  const contentIds: string[] = [];
  for (let i = 0; i < CONTENT_ITEMS; i++) {
    const row = await prisma.content.create({
      data: {
        modelId: model.id,
        title: `${runTag} #${i}`,
        type: 'IMAGE',
        tier: 'FREE',
        storageKey: `content/${model.id}/${runTag}-${i}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        isPublished: true,
      },
    });
    contentIds.push(row.id);
  }

  const subscriberCookies: string[] = [];
  const conversationIds: string[] = [];
  for (let i = 0; i < SUBSCRIBERS; i++) {
    const sub = await prisma.user.create({
      data: { ...base, email: email(`sub${i}`), passwordHash: 'x', role: 'SUBSCRIBER' },
    });
    userIds.push(sub.id);
    await prisma.creditWallet.create({ data: { userId: sub.id, balance: 100 } });
    const conversation = await prisma.conversation.create({
      data: { subscriberId: sub.id, modelId: model.id },
    });
    conversationIds.push(conversation.id);
    subscriberCookies.push(`access_token=${signAccess({ userId: sub.id, role: 'subscriber' })}`);
  }

  return {
    runTag,
    userIds,
    contentIds,
    conversationIds,
    modelId: model.id,
    loginEmail: loginUser.email,
    loginPassword,
    subscriberCookies,
  };
}

async function cleanup(
  prisma: import('../../src/lib/prisma.js').PrismaClient,
  seeded: Seeded,
): Promise<void> {
  // Children first; users last. Every id is one this run created.
  await prisma.conversation.deleteMany({ where: { id: { in: seeded.conversationIds } } });
  await prisma.content.deleteMany({ where: { id: { in: seeded.contentIds } } });
  await prisma.creditWallet.deleteMany({ where: { userId: { in: seeded.userIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: seeded.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: seeded.userIds } } });
}

// ── Report ───────────────────────────────────────────────────────────────────
const ms = (value: number) => `${value.toFixed(2)} ms`;

function table(results: ScenarioResult[]): string {
  const header =
    '| Scenario | Requests | p50 | p95 | p99 | req/s | 2xx | 429 | other non-2xx |\n' +
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const rows = results.map(
    (r) =>
      `| ${r.name} | ${r.requests} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ` +
      `${r.rps.toFixed(1)} | ${r.ok2xx} | ${r.rateLimited429} | ${r.otherNon2xx} |`,
  );
  return [header, ...rows].join('\n');
}

function environment(mode: string): string {
  const cpu = cpus()[0]?.model ?? 'unknown';
  return [
    `- **Date:** ${new Date().toISOString()}`,
    `- **Mode:** ${mode}`,
    `- **Node:** ${process.version}`,
    `- **OS:** ${platform()} ${release()}`,
    `- **CPU:** ${cpu} × ${cpus().length}`,
    `- **Memory:** ${(totalmem() / 1024 ** 3).toFixed(0)} GB`,
    `- **Database host:** ${DRY_RUN ? 'none (dry run — no query is issued)' : dbHost}`,
    '- **Server:** `buildServer()` in-process on 127.0.0.1 (ephemeral port), all providers on mock adapters, logging off',
    '- **Load generator:** autocannon, same process',
  ].join('\n');
}

function writeBaseline(results: ScenarioResult[], mode: string): void {
  const notes = results.map((r) => `- **${r.name}** — ${r.note}`).join('\n');
  const dryRunCaveat = DRY_RUN
    ? `\n> **Dry run — DB-backed scenarios not baselined.** Only \`GET /health\`\n` +
      `> (which issues no query) was measured. The login, anonymous content\n` +
      `> list, wallet balance and conversation list scenarios need a\n` +
      `> non-production database; re-run without \`--dry-run\` against one to\n` +
      `> fill them in. The numbers below say nothing about database latency.\n`
    : '';
  const body = `# Load-test baseline

Generated by \`pnpm --filter @creator-platform/api load${DRY_RUN ? ' --dry-run' : ''}\`
(\`apps/api/scripts/load/run.ts\`, Session 12 D8). Re-running overwrites this file.
${dryRunCaveat}
## Environment

${environment(mode)}

## Results

${table(results)}

Latencies are per-request response times measured by the load generator
(p50/p95/p99 computed from every sample). Rate limits stay **on**: each
scenario is sized to its own budget, and any 429 is counted in its own column.

## Scenario notes

${notes}
`;
  writeFileSync(BASELINE_PATH, body);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { buildServer } = await import('../../src/index.js');
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const scenarios: Scenario[] = [
    {
      name: 'GET /health',
      path: '/health',
      duration: 10,
      connections: 10,
      note: 'unlimited by policy (liveness probe); 10 s, 10 connections, no DB.',
    },
  ];

  let prisma: import('../../src/lib/prisma.js').PrismaClient | null = null;
  let seeded: Seeded | null = null;

  try {
    if (!DRY_RUN) {
      prisma = (await import('../../src/lib/prisma.js')).prisma;
      seeded = await seed(prisma, (payload) => app.jwt.access.sign(payload));
      const cookies = seeded.subscriberCookies;
      let turn = 0;

      scenarios.push(
        {
          name: 'POST /api/auth/login (bcrypt-bound worst case)',
          path: '/api/auth/login',
          method: 'POST',
          amount: 10,
          connections: 1,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: seeded.loginEmail, password: seeded.loginPassword }),
          note:
            'exactly the 10/IP/15 min login budget, one connection: every request is a real ' +
            'cost-12 bcrypt compare plus a refresh-token hash (cost 10). Reported separately — ' +
            'it measures bcrypt, not the stack.',
        },
        {
          name: 'GET /api/content/model/:id (anonymous)',
          path: `/api/content/model/${seeded.modelId}`,
          amount: 120,
          connections: 10,
          note: `${CONTENT_ITEMS} FREE published items, anonymous; sized to the 120/IP/min budget.`,
        },
        {
          name: 'GET /api/wallet/balance (authenticated)',
          path: '/api/wallet/balance',
          amount: 60,
          connections: 10,
          perRequestHeaders: () => ({ cookie: cookies[turn++ % cookies.length] }),
          note: 'sized to the 60/IP/min budget (this limit is IP-scoped); cookies rotate across seeded subscribers.',
        },
        {
          name: 'GET /api/messages/conversations (authenticated)',
          path: '/api/messages/conversations',
          amount: SUBSCRIBERS * 120,
          connections: 10,
          perRequestHeaders: () => ({ cookie: cookies[turn++ % cookies.length] }),
          note: `${SUBSCRIBERS} seeded subscribers × their 120/min per-user budget, round-robin.`,
        },
      );
    }

    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
      console.log(`[load] ${scenario.name} …`);
      results.push(await runScenario(baseUrl, scenario));
    }

    console.log(`\n${table(results)}\n`);
    writeBaseline(results, DRY_RUN ? 'dry run (GET /health only)' : 'full');
    console.log(`[load] baseline written to ${BASELINE_PATH}`);
  } finally {
    if (prisma && seeded) {
      await cleanup(prisma, seeded).catch((err: unknown) => {
        console.error(`[load] cleanup failed for run ${seeded!.runTag}:`, err);
        process.exitCode = 1;
      });
    }
    await app.close();
    if (prisma) await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('[load] failed:', err);
  process.exit(1);
});
