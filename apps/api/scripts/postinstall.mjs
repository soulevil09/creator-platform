// Runs `prisma generate` on install so the type-safe client is ready.
//
// During Session 01 the schema intentionally has NO models yet, and in that
// state `prisma generate` exits non-zero with a "you don't have any models"
// message. That specific case is expected and must not fail `pnpm install`.
// Any other generate failure is real and is propagated.
import { spawnSync } from 'node:child_process';

const result = spawnSync('prisma', ['generate'], {
  stdio: 'pipe',
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);

const noModelsYet = /don't have any models|any models defined/i.test(output);

if (result.status === 0 || noModelsYet) {
  if (noModelsYet) {
    process.stdout.write('\n[postinstall] No Prisma models yet — skipping client generation.\n');
  }
  process.exit(0);
}

process.exit(result.status ?? 1);
