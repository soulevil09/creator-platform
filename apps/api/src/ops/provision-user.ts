// =============================================================================
// Out-of-band user provisioning (Session 13, D4).
//
// There is no public path to an ADMIN account, and while email is disabled
// public registration answers 503 — so the operator needs a way to create a
// *verified* account directly. This is it, reached only through the ops CLI
// (scripts/ops/create-user.ts) run inside the API container by someone who
// already holds a shell on the box.
//
// It reuses the auth service's own rules rather than restating them: the same
// email / password / display-name schema as POST /register, the same bcrypt
// cost. A model also gets the minimal ModelProfile the domain requires, left
// PENDING — provisioning an account is not approving it to take money.
//
// What it never does: accept the password from anywhere but the caller (the
// CLI reads stdin), echo it, or write it — or its hash — to the audit row.
// =============================================================================
import { z } from 'zod';
import { DEFAULT_LOCALE } from '@creator-platform/shared';
import type { PrismaClient } from '../lib/prisma.js';
import { hashPassword } from '../modules/auth/password.js';
import { registerSchema } from '../modules/auth/auth.schema.js';

export const PROVISION_ROLES = ['admin', 'model', 'subscriber'] as const;
export type ProvisionRole = (typeof PROVISION_ROLES)[number];

/** The actor recorded on the audit row: a machine entrance, not a user. */
export const CLI_ACTOR = 'system:cli';

export const provisionSchema = z
  .object({
    email: registerSchema.shape.email,
    password: registerSchema.shape.password,
    displayName: registerSchema.shape.displayName,
    role: z.enum(PROVISION_ROLES),
    // ISO 3166-1 alpha-2, as the onboarding profile stores it.
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code')
      .optional(),
  })
  .refine((input) => input.role !== 'model' || input.country !== undefined, {
    message: 'a model needs --country',
    path: ['country'],
  });

export type ProvisionInput = z.input<typeof provisionSchema>;

/** A refusal the CLI reports as a short machine code; never carries input. */
export class ProvisionError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'email_taken',
    readonly issues: string[] = [],
  ) {
    super(code);
    this.name = 'ProvisionError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * Create one verified user (and, for a model, its PENDING profile) plus the
 * `user.provisioned` audit row, atomically. Returns only the new id.
 */
export async function provisionUser(
  prisma: PrismaClient,
  input: ProvisionInput,
): Promise<{ userId: string }> {
  const parsed = provisionSchema.safeParse(input);
  if (!parsed.success) {
    // Paths and rule messages only — never a submitted value (the password).
    throw new ProvisionError(
      'invalid_input',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`),
    );
  }
  const data = parsed.data;

  // Refuse an existing email before hashing; the unique constraint below
  // still decides a race between two concurrent runs.
  if (await prisma.user.findUnique({ where: { email: data.email } })) {
    throw new ProvisionError('email_taken');
  }

  const passwordHash = await hashPassword(data.password);
  const role = data.role.toUpperCase() as 'ADMIN' | 'MODEL' | 'SUBSCRIBER';

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash,
          displayName: data.displayName,
          role,
          isVerified: true,
          preferredLocale: DEFAULT_LOCALE,
        },
      });
      if (role === 'MODEL') {
        await tx.modelProfile.create({
          data: {
            userId: user.id,
            displayName: data.displayName,
            country: data.country!,
            // approvalStatus defaults to PENDING: an admin still decides.
          },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'user.provisioned',
          entity: 'User',
          entityId: user.id,
          metadata: { role: data.role, actor: CLI_ACTOR },
        },
      });
      return { userId: user.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ProvisionError('email_taken');
    throw err;
  }
}
