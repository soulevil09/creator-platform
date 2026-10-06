// =============================================================================
// Ops CLI entry: provision a verified user (Session 13, D4).
//
// Bundled to dist/scripts/ops/create-user.js and run inside the API container:
//
//   docker compose exec api node dist/scripts/ops/create-user.js \
//     --role admin --email you@example.com --display-name "You"
//
// All logic lives in src/ops/ (unit-tested); this file only wires the real
// process streams and the real database client. It deliberately does not
// import src/index.ts (that would boot the HTTP server) or src/lib/env.ts —
// it needs DATABASE_URL and nothing else.
// =============================================================================
import { prisma } from '../../src/lib/prisma.js';
import { runCreateUser } from '../../src/ops/create-user-cli.js';

const code = await runCreateUser({
  argv: process.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  prisma,
});
await prisma.$disconnect();
process.exit(code);
