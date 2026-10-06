// =============================================================================
// `create-user` ops CLI (Session 13, D4).
//
// Driven through `runCreateUser` with in-memory streams and the shared fake
// Prisma client. The password must never surface in stdout, stderr, the audit
// trail or any column but `passwordHash`.
// =============================================================================
import { PassThrough } from 'node:stream';
import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../lib/prisma.js';
import { createFakePrisma, type FakePrisma } from '../test/fake-prisma.js';
import { runCreateUser, type CliInput } from './create-user-cli.js';

const PASSWORD = 'correct-horse-battery-staple';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Piped stdin: the password is the first line. */
async function run(prisma: FakePrisma, argv: string[], stdinText = `${PASSWORD}\n`): Promise<Run> {
  const stdin = new PassThrough();
  stdin.end(stdinText);
  let stdout = '';
  let stderr = '';
  const code = await runCreateUser({
    argv,
    stdin,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    prisma: prisma as unknown as PrismaClient,
  });
  return { code, stdout, stderr };
}

const adminArgs = ['--role', 'admin', '--email', 'Admin@Example.com', '--display-name', 'Ops'];

/** Everything the CLI could have leaked into, as one string. */
function everything(prisma: FakePrisma, result: Run): string {
  const users = prisma.__users.map(({ passwordHash: _hash, ...rest }) => rest);
  return JSON.stringify({
    out: result.stdout,
    err: result.stderr,
    audit: prisma.__auditLogs,
    users,
    profiles: prisma.__profiles,
  });
}

describe('create-user CLI', () => {
  it('creates a VERIFIED admin, prints only the new id, and audits it as system:cli', async () => {
    const prisma = createFakePrisma();
    const result = await run(prisma, adminArgs);

    expect(result.code).toBe(0);
    const user = prisma.__users[0];
    expect(result.stdout).toBe(`${user.id}\n`);
    expect(user).toMatchObject({
      email: 'admin@example.com',
      role: 'ADMIN',
      isVerified: true,
      displayName: 'Ops',
    });
    // Same hashing path as registration: bcrypt, cost 12.
    expect(bcrypt.getRounds(user.passwordHash)).toBe(12);
    expect(await bcrypt.compare(PASSWORD, user.passwordHash)).toBe(true);

    expect(prisma.__auditLogs).toHaveLength(1);
    expect(prisma.__auditLogs[0]).toMatchObject({
      actorId: null,
      action: 'user.provisioned',
      entity: 'User',
      entityId: user.id,
      metadata: { role: 'admin', actor: 'system:cli' },
    });
  });

  it('a model gets its minimal profile, PENDING approval', async () => {
    const prisma = createFakePrisma();
    const result = await run(prisma, [
      '--role',
      'model',
      '--email',
      'model@example.com',
      '--display-name',
      'Model',
      '--country',
      'br',
    ]);
    expect(result.code).toBe(0);
    const user = prisma.__users[0];
    expect(user.role).toBe('MODEL');
    expect(prisma.__profiles).toHaveLength(1);
    expect(prisma.__profiles[0]).toMatchObject({
      userId: user.id,
      displayName: 'Model',
      country: 'BR',
      approvalStatus: 'PENDING',
    });
  });

  it('a model without --country is refused, nothing written', async () => {
    const prisma = createFakePrisma();
    const result = await run(prisma, [
      '--role',
      'model',
      '--email',
      'model@example.com',
      '--display-name',
      'Model',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/invalid_input[\s\S]*country/);
    expect(prisma.__users).toHaveLength(0);
  });

  it('a subscriber is created verified, with no profile', async () => {
    const prisma = createFakePrisma();
    const result = await run(prisma, [
      '--role',
      'subscriber',
      '--email',
      'sub@example.com',
      '--display-name',
      'Sub',
    ]);
    expect(result.code).toBe(0);
    expect(prisma.__users[0]).toMatchObject({ role: 'SUBSCRIBER', isVerified: true });
    expect(prisma.__profiles).toHaveLength(0);
  });

  it('refuses an existing email: exit 1, no change, no audit row', async () => {
    const prisma = createFakePrisma();
    expect((await run(prisma, adminArgs)).code).toBe(0);
    const before = JSON.stringify(prisma.__users);

    const again = await run(prisma, adminArgs, 'another-long-password\n');
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/email_taken/);
    expect(again.stdout).toBe('');
    expect(JSON.stringify(prisma.__users)).toBe(before);
    expect(prisma.__auditLogs).toHaveLength(1);
  });

  it('enforces the registration password policy (min 8)', async () => {
    const prisma = createFakePrisma();
    const result = await run(prisma, adminArgs, 'short\n');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/invalid_input[\s\S]*password/);
    expect(result.stderr).not.toContain('short\n');
    expect(prisma.__users).toHaveLength(0);
    expect(prisma.__auditLogs).toHaveLength(0);
  });

  it('the password never appears in output, audit, or any stored column but the hash', async () => {
    const prisma = createFakePrisma();
    const ok = await run(prisma, adminArgs);
    expect(ok.code).toBe(0);
    expect(everything(prisma, ok)).not.toContain(PASSWORD);
    expect(prisma.__users[0].passwordHash).not.toContain(PASSWORD);

    // Refusal paths too.
    const dup = await run(prisma, adminArgs);
    expect(everything(prisma, dup)).not.toContain(PASSWORD);
  });

  it('there is no --password flag: it is a usage error that never echoes the value', async () => {
    const prisma = createFakePrisma();
    const result = await run(prisma, [...adminArgs, '--password', 'hunter2hunter2']);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain('hunter2hunter2');
    expect(prisma.__users).toHaveLength(0);
  });

  it('rejects an unknown role and missing arguments with usage (exit 2)', async () => {
    const prisma = createFakePrisma();
    expect(
      (await run(prisma, ['--role', 'root', '--email', 'a@b.co', '--display-name', 'x'])).code,
    ).toBe(2);
    expect((await run(prisma, ['--role', 'admin'])).code).toBe(2);
    expect(prisma.__users).toHaveLength(0);
  });

  it('--help prints usage and exits 0 without touching stdin or the database', async () => {
    const prisma = createFakePrisma();
    const result = await run(prisma, ['--help'], '');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Usage: create-user/);
    expect(prisma.__users).toHaveLength(0);
  });

  describe('interactive (TTY) prompt', () => {
    function ttyStdin(lines: string[]): CliInput {
      const stream = new PassThrough() as PassThrough & CliInput;
      stream.isTTY = true;
      stream.setRawMode = vi.fn();
      // Type each line once the prompt is listening (one per prompt).
      let next = 0;
      const originalOn = stream.on.bind(stream);
      stream.on = ((event: string, listener: (...args: unknown[]) => void) => {
        const result = originalOn(event, listener);
        if (event === 'data' && next < lines.length) {
          const line = lines[next++];
          setImmediate(() => stream.write(`${line}\r`));
        }
        return result;
      }) as typeof stream.on;
      return stream;
    }

    async function runTty(prisma: FakePrisma, lines: string[]) {
      let stdout = '';
      let stderr = '';
      const stdin = ttyStdin(lines);
      const code = await runCreateUser({
        argv: adminArgs,
        stdin,
        stdout: { write: (c: string) => (stdout += c) },
        stderr: { write: (c: string) => (stderr += c) },
        prisma: prisma as unknown as PrismaClient,
      });
      return { code, stdout, stderr, stdin };
    }

    it('asks twice with input hidden (raw mode, nothing echoed) and creates the user', async () => {
      const prisma = createFakePrisma();
      const result = await runTty(prisma, [PASSWORD, PASSWORD]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('Password: \nRepeat password: \n');
      expect(result.stdin.setRawMode).toHaveBeenCalledWith(true);
      expect(result.stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(prisma.__users).toHaveLength(1);
    });

    it('refuses when the two entries differ', async () => {
      const prisma = createFakePrisma();
      const result = await runTty(prisma, [PASSWORD, `${PASSWORD}x`]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/passwords do not match/);
      expect(result.stderr).not.toContain(PASSWORD);
      expect(prisma.__users).toHaveLength(0);
    });
  });
});
