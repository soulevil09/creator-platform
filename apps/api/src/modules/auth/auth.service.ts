// Auth business logic: registration, email verification, credential checks, and
// refresh-token rotation. This layer owns the database and password/crypto work
// but knows nothing about HTTP, cookies, or JWTs — the routes layer wires those.
//
// Deviation note: per session guidance we use `bcryptjs` (pure JS, no native
// build) instead of `bcrypt`. Password hashes use cost 12; refresh-token hashes
// use cost 10 (cheaper, and the token is already high-entropy).
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Role } from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { Emailer } from '../../lib/email.js';
import type { RegisterInput } from './auth.schema.js';

const PASSWORD_COST = 12;
const REFRESH_COST = 10;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Prisma role enum values (uppercase) — kept local to avoid a runtime import. */
type PrismaRole = 'ADMIN' | 'MODEL' | 'SUBSCRIBER';

function toPrismaRole(role: Role): PrismaRole {
  return role.toUpperCase() as PrismaRole;
}
function toApiRole(role: PrismaRole): Role {
  return role.toLowerCase() as Role;
}

/**
 * bcrypt silently truncates its input at 72 bytes. A refresh JWT is longer than
 * that and its signature lives past byte 72, so bcrypt-ing the raw token would
 * only protect the header + start of the payload. We SHA-256 the token first
 * (fixed 64-char, full-entropy digest) and bcrypt *that*, so the whole token —
 * signature included — is bound to the stored hash.
 */
function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Typed error that carries the HTTP status the route should respond with. */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthServiceDeps {
  prisma: PrismaClient;
  emailer: Emailer;
}

export interface MeResult {
  userId: string;
  email: string;
  role: Role;
  displayName: string;
  isVerified: boolean;
}

export function createAuthService({ prisma, emailer }: AuthServiceDeps) {
  return {
    /** Create an unverified account and send the verification email. */
    async register(input: RegisterInput): Promise<{ userId: string; role: Role }> {
      const existing = await prisma.user.findUnique({ where: { email: input.email } });
      if (existing) {
        // Duplicate: do not create and do not send an email.
        throw new AuthError(409, 'Email already registered');
      }

      const passwordHash = await bcrypt.hash(input.password, PASSWORD_COST);
      const verifyToken = randomBytes(32).toString('hex');
      const verifyTokenExpiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

      const user = await prisma.user.create({
        data: {
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          role: toPrismaRole(input.role),
          isVerified: false,
          verifyToken,
          verifyTokenExpiresAt,
        },
      });

      await emailer.sendVerificationEmail(user.email, verifyToken);

      return { userId: user.id, role: input.role };
    },

    /** Consume a verification token, marking the account verified. */
    async verifyEmail(token: string): Promise<void> {
      const user = await prisma.user.findUnique({ where: { verifyToken: token } });
      if (!user || !user.verifyTokenExpiresAt || user.verifyTokenExpiresAt.getTime() < Date.now()) {
        throw new AuthError(400, 'Invalid or expired verification token');
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { isVerified: true, verifyToken: null, verifyTokenExpiresAt: null },
      });
    },

    /**
     * Validate login credentials. Order matters: we confirm the password before
     * revealing the "not verified" state, so an attacker can't probe which
     * emails are registered-but-unverified without the password.
     */
    async validateCredentials(
      email: string,
      password: string,
    ): Promise<{ userId: string; role: Role; displayName: string }> {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        throw new AuthError(401, 'Invalid credentials');
      }
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) {
        throw new AuthError(401, 'Invalid credentials');
      }
      if (!user.isVerified) {
        throw new AuthError(403, 'Email not verified');
      }
      return {
        userId: user.id,
        role: toApiRole(user.role as PrismaRole),
        displayName: user.displayName,
      };
    },

    /** Persist the bcrypt hash of a (newly issued) refresh token. */
    async storeRefreshToken(userId: string, refreshToken: string): Promise<void> {
      const refreshTokenHash = await bcrypt.hash(digestToken(refreshToken), REFRESH_COST);
      await prisma.user.update({ where: { id: userId }, data: { refreshTokenHash } });
    },

    /**
     * Confirm a presented refresh token matches the stored hash. Throws 401 if
     * the user is gone, was logged out (hash null), or the token doesn't match.
     */
    async assertRefreshTokenValid(userId: string, presentedToken: string): Promise<void> {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || !user.refreshTokenHash) {
        throw new AuthError(401, 'Invalid refresh token');
      }
      const ok = await bcrypt.compare(digestToken(presentedToken), user.refreshTokenHash);
      if (!ok) {
        throw new AuthError(401, 'Invalid refresh token');
      }
    },

    /** Invalidate the stored refresh token (logout). */
    async clearRefreshToken(userId: string): Promise<void> {
      await prisma.user.update({ where: { id: userId }, data: { refreshTokenHash: null } });
    },

    /** Fetch the authenticated user's public profile for GET /me. */
    async getMe(userId: string): Promise<MeResult> {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new AuthError(401, 'Unauthorized');
      }
      return {
        userId: user.id,
        email: user.email,
        role: toApiRole(user.role as PrismaRole),
        displayName: user.displayName,
        isVerified: user.isVerified,
      };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
