// =============================================================================
// `create-user` CLI (Session 13, D4) — argument parsing and I/O, kept apart
// from the entry file so the suite can drive it with in-memory streams.
//
//   docker compose exec api node dist/scripts/ops/create-user.js \
//     --role admin --email you@example.com --display-name "You"
//
// The password is read from STDIN ONLY: a hidden prompt on a TTY (asked twice),
// or the first line of piped input. There is deliberately no `--password` flag
// and no env var — argv lands in shell history and `ps`, env in `/proc` and
// `docker inspect`. stdout carries the new user id and nothing else, so it can
// be captured; everything for humans goes to stderr.
// =============================================================================
import { parseArgs } from 'node:util';
import type { PrismaClient } from '../lib/prisma.js';
import { PROVISION_ROLES, ProvisionError, provisionUser } from './provision-user.js';

export const USAGE = `Usage: create-user --role <admin|model|subscriber> --email <email> --display-name <name> [--country <CC>]

Creates a VERIFIED user. The password is read from stdin only:
  interactive:  you are prompted twice, input hidden
  piped:        the first line of stdin, e.g. from a password manager
A model also needs --country (ISO 3166-1 alpha-2) and is created PENDING approval.
Prints the new user id on success. Exit codes: 0 created, 1 refused, 2 usage.`;

/** Readable side of a TTY-capable stream (process.stdin satisfies it). */
export interface CliInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface CliIo {
  argv: string[];
  stdin: CliInput;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  prisma: PrismaClient;
}

/** First line of a piped stdin (trailing CR/LF stripped). */
async function readPipedLine(stdin: CliInput): Promise<string> {
  let data = '';
  for await (const chunk of stdin) {
    data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const newline = data.indexOf('\n');
    if (newline !== -1) return data.slice(0, newline).replace(/\r$/, '');
  }
  return data.replace(/\r?\n?$/, '');
}

/** One hidden line from a TTY: raw mode, nothing echoed, Ctrl-C aborts. */
function readHiddenLine(stdin: CliInput, stderr: CliIo['stderr'], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    stderr.write(prompt);
    stdin.setRawMode?.(true);
    stdin.resume();
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('aborted'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stderr.write('\n');
    };
    stdin.on('data', onData);
  });
}

async function readPassword(io: CliIo): Promise<string> {
  if (!io.stdin.isTTY) return readPipedLine(io.stdin);
  const first = await readHiddenLine(io.stdin, io.stderr, 'Password: ');
  const second = await readHiddenLine(io.stdin, io.stderr, 'Repeat password: ');
  if (first !== second) throw new ProvisionError('invalid_input', ['passwords do not match']);
  return first;
}

/** Run the CLI; resolves to the process exit code. Never prints the password. */
export async function runCreateUser(io: CliIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: io.argv,
      strict: true,
      allowPositionals: false,
      options: {
        role: { type: 'string' },
        email: { type: 'string' },
        'display-name': { type: 'string' },
        country: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    // An unknown flag (including any attempt at --password) is a usage error.
    // Node's message names the flag, never its value.
    io.stderr.write(`${err instanceof Error ? err.message : 'invalid arguments'}\n\n${USAGE}\n`);
    return 2;
  }

  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!values.role || !values.email || !values['display-name']) {
    io.stderr.write(`--role, --email and --display-name are required.\n\n${USAGE}\n`);
    return 2;
  }
  if (!(PROVISION_ROLES as readonly string[]).includes(values.role)) {
    io.stderr.write(`--role must be one of: ${PROVISION_ROLES.join(', ')}\n`);
    return 2;
  }

  try {
    const password = await readPassword(io);
    const { userId } = await provisionUser(io.prisma, {
      role: values.role as (typeof PROVISION_ROLES)[number],
      email: values.email,
      displayName: values['display-name'],
      country: values.country,
      password,
    });
    io.stdout.write(`${userId}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ProvisionError) {
      io.stderr.write(
        `refused: ${err.code}${err.issues.length ? `\n  ${err.issues.join('\n  ')}` : ''}\n`,
      );
      return 1;
    }
    if (err instanceof Error && err.message === 'aborted') {
      io.stderr.write('aborted\n');
      return 1;
    }
    // A database fault: the class name only — a Prisma message can quote SQL.
    io.stderr.write(`failed: ${err instanceof Error ? err.name : 'unknown error'}\n`);
    return 1;
  }
}
