// =============================================================================
// In-memory Prisma stand-in for the payments and wallet suites.
//
// Same philosophy as the auth/onboarding/content suites — no real database —
// but those each grew their own single-purpose fake. Payments touches eight
// models at once (and `$transaction`), so this one is factored out and shared.
//
// It implements only the query shapes the code under test actually issues, and
// it enforces the two database-level guarantees the tests are about:
//
//   * `PaymentTransaction.idempotencyKey` is UNIQUE — a duplicate insert
//     rejects with a P2002-shaped error, exactly as Postgres would.
//   * `CreditWallet.balance` never goes negative — a conditional `updateMany`
//     matches zero rows rather than writing a negative balance.
//   * A `PaymentTransaction` can only be claimed by a payout while
//     `payoutId IS NULL` — the conditional `updateMany` the payout run relies
//     on to keep two concurrent runs from double-including a row.
//
// `$transaction(fn)` runs `fn` against this same client. It does NOT roll back
// on throw; the tests that assert "nothing was mutated" exercise paths that
// fail before their first write, which is the property worth pinning anyway.
// =============================================================================
import { vi } from 'vitest';
import type { Emailer } from '../lib/email.js';

export type FakeRole = 'ADMIN' | 'MODEL' | 'SUBSCRIBER';
export type FakeTier = 'FREE' | 'STANDARD' | 'PREMIUM';
export type FakeProviderEnum = 'WOOVI' | 'NOWPAYMENTS' | 'CCBILL_MOCK';
export type FakePaymentStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

export interface FakeUser {
  id: string;
  email: string;
  passwordHash: string;
  role: FakeRole;
  displayName: string;
  isVerified: boolean;
  verifyToken: string | null;
  verifyTokenExpiresAt: Date | null;
  refreshTokenHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeProfile {
  id: string;
  userId: string;
  /** Paxum destination address; null until the model sets one. UNIQUE. */
  payoutEmail: string | null;
  updatedAt: Date;
}

export interface FakeContent {
  id: string;
  modelId: string;
  title: string;
  type: 'IMAGE' | 'VIDEO';
  tier: FakeTier;
  storageKey: string;
  mimeType: string;
  isPublished: boolean;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface FakeAccess {
  id: string;
  contentId: string;
  userId: string;
  grantReason: string;
  grantedAt: Date;
  expiresAt: Date | null;
}

export interface FakeWallet {
  id: string;
  userId: string;
  balance: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTransaction {
  id: string;
  userId: string;
  type: 'SUBSCRIPTION' | 'CREDIT_PACK';
  provider: FakeProviderEnum;
  providerTransactionId: string | null;
  idempotencyKey: string;
  amount: number;
  currency: string;
  creditsGranted: number | null;
  modelId: string | null;
  tier: FakeTier | null;
  status: FakePaymentStatus;
  confirmedAt: Date | null;
  metadata: unknown;
  /** Revenue share (Session 06) — null on CREDIT_PACK rows. */
  modelShareCents: number | null;
  platformShareCents: number | null;
  /** Null means "still payable"; set when a payout run claims the row. */
  payoutId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type FakePayoutStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type FakePayoutProvider = 'PAXUM' | 'PAXUM_MOCK';

export interface FakePayout {
  id: string;
  modelId: string;
  amountCents: number;
  currency: string;
  status: FakePayoutStatus;
  provider: FakePayoutProvider;
  providerPayoutId: string | null;
  idempotencyKey: string;
  periodStart: Date;
  periodEnd: Date;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface FakeSubscription {
  id: string;
  subscriberId: string;
  modelId: string;
  tier: FakeTier;
  status: string;
  provider: FakeProviderEnum;
  providerSubscriptionId: string | null;
  currentPeriodEnd: Date;
}

export interface FakeAudit {
  id: string;
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
}

type Where = Record<string, unknown>;

/** Mimics Prisma's unique-constraint rejection (Postgres 23505 → P2002). */
export class FakeUniqueConstraintError extends Error {
  readonly code = 'P2002';

  constructor(readonly target: string) {
    super(`Unique constraint failed on the fields: (\`${target}\`)`);
    this.name = 'PrismaClientKnownRequestError';
  }
}

/** Apply Prisma's `{ increment }` / `{ decrement }` update operators. */
function applyNumericOps(row: object, data: Record<string, unknown>): Record<string, unknown> {
  const target = row as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const op = value as { increment?: number; decrement?: number } | null;
    if (op && typeof op === 'object' && !(op instanceof Date)) {
      if (typeof op.increment === 'number') {
        target[key] = (target[key] as number) + op.increment;
        continue;
      }
      if (typeof op.decrement === 'number') {
        target[key] = (target[key] as number) - op.decrement;
        continue;
      }
    }
    rest[key] = value;
  }
  return rest;
}

export function createFakePrisma() {
  const users: FakeUser[] = [];
  const profiles: FakeProfile[] = [];
  const content: FakeContent[] = [];
  const accesses: FakeAccess[] = [];
  const wallets: FakeWallet[] = [];
  const transactions: FakeTransaction[] = [];
  const subscriptions: FakeSubscription[] = [];
  const payouts: FakePayout[] = [];
  const auditLogs: FakeAudit[] = [];
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${++seq}`;

  const matchUser = (u: FakeUser, where: Where) =>
    (where.id !== undefined && u.id === where.id) ||
    (where.email !== undefined && u.email === where.email) ||
    (where.verifyToken !== undefined && u.verifyToken === where.verifyToken);

  /**
   * Match one transaction against the `where` shapes the code under test uses:
   * scalar equality, `{ in: [...] }` on id, and an explicit `null` on payoutId
   * (which is what makes the payout claim a compare-and-set).
   */
  const txMatches = (t: FakeTransaction, where: Where): boolean => {
    for (const [key, condition] of Object.entries(where)) {
      const value = (t as unknown as Record<string, unknown>)[key];
      if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
        const op = condition as { in?: unknown[]; not?: unknown };
        if (Array.isArray(op.in) && !op.in.includes(value)) return false;
        if ('not' in op) {
          if (op.not === null && value === null) return false;
          if (op.not !== null && value === op.not) return false;
        }
        continue;
      }
      if (value !== condition) return false;
    }
    return true;
  };

  const payoutMatches = (p: FakePayout, where: Where): boolean => {
    for (const [key, condition] of Object.entries(where)) {
      const value = (p as unknown as Record<string, unknown>)[key];
      if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
        const op = condition as { in?: unknown[] };
        if (Array.isArray(op.in) && !op.in.includes(value)) return false;
        continue;
      }
      if (value !== condition) return false;
    }
    return true;
  };

  const findTx = (where: Where): FakeTransaction | undefined => {
    if (where.id !== undefined) return transactions.find((t) => t.id === where.id);
    if (where.idempotencyKey !== undefined)
      return transactions.find((t) => t.idempotencyKey === where.idempotencyKey);
    return undefined;
  };

  const client = {
    user: {
      findUnique: async ({ where }: { where: Where }) =>
        users.find((u) => matchUser(u, where)) ?? null,
      create: async ({ data }: { data: Partial<FakeUser> }) => {
        const now = new Date();
        const user = {
          refreshTokenHash: null,
          verifyToken: null,
          verifyTokenExpiresAt: null,
          isVerified: false,
          ...data,
          id: nextId('u'),
          createdAt: now,
          updatedAt: now,
        } as FakeUser;
        users.push(user);
        return user;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeUser> }) => {
        const user = users.find((u) => u.id === where.id);
        if (!user) throw new Error('record not found');
        Object.assign(user, data, { updatedAt: new Date() });
        return user;
      },
    },

    modelProfile: {
      findUnique: async ({ where }: { where: Where }) =>
        profiles.find(
          (p) =>
            (where.userId !== undefined && p.userId === where.userId) ||
            (where.id !== undefined && p.id === where.id) ||
            (where.payoutEmail !== undefined && p.payoutEmail === where.payoutEmail),
        ) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { userId: string };
        data: Partial<FakeProfile>;
      }) => {
        const row = profiles.find((p) => p.userId === where.userId);
        if (!row) throw new Error('record not found');
        // `payoutEmail` is UNIQUE: two models pointing at one Paxum address
        // would misroute funds, so the constraint rejects here exactly as
        // Postgres would rather than letting the service decide.
        if (
          data.payoutEmail != null &&
          profiles.some((p) => p.userId !== where.userId && p.payoutEmail === data.payoutEmail)
        ) {
          throw new FakeUniqueConstraintError('payoutEmail');
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },

    content: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        content.find((c) => c.id === where.id) ?? null,
      findMany: async ({ where }: { where: Where }) =>
        content.filter((c) => {
          if (where.modelId !== undefined && c.modelId !== where.modelId) return false;
          if (where.deletedAt === null && c.deletedAt !== null) return false;
          if (where.isPublished !== undefined && c.isPublished !== where.isPublished) return false;
          const tierFilter = where.tier as { in?: FakeTier[] } | FakeTier | undefined;
          if (typeof tierFilter === 'string' && c.tier !== tierFilter) return false;
          if (tierFilter && typeof tierFilter === 'object' && Array.isArray(tierFilter.in)) {
            if (!tierFilter.in.includes(c.tier)) return false;
          }
          return true;
        }),
    },

    contentAccess: {
      findUnique: async ({ where }: { where: Where }) => {
        const key = where.contentId_userId as { contentId: string; userId: string } | undefined;
        if (!key) return null;
        return (
          accesses.find((a) => a.contentId === key.contentId && a.userId === key.userId) ?? null
        );
      },
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: Where;
        update: Partial<FakeAccess>;
        create: Partial<FakeAccess> & { contentId: string; userId: string };
      }) => {
        const key = where.contentId_userId as { contentId: string; userId: string };
        const existing = accesses.find(
          (a) => a.contentId === key.contentId && a.userId === key.userId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = {
          grantReason: 'unknown',
          grantedAt: new Date(),
          expiresAt: null,
          ...create,
          id: nextId('acc'),
        } as FakeAccess;
        accesses.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { contentId: string; userId: string } }) => {
        const before = accesses.length;
        for (let i = accesses.length - 1; i >= 0; i--) {
          if (accesses[i].contentId === where.contentId && accesses[i].userId === where.userId) {
            accesses.splice(i, 1);
          }
        }
        return { count: before - accesses.length };
      },
    },

    creditWallet: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        wallets.find((w) => w.userId === where.userId) ?? null,
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { userId: string };
        update: Record<string, unknown>;
        create: { userId: string; balance: number };
      }) => {
        const existing = wallets.find((w) => w.userId === where.userId);
        if (existing) {
          const rest = applyNumericOps(existing, update);
          Object.assign(existing, rest, { updatedAt: new Date() });
          return existing;
        }
        const now = new Date();
        const row: FakeWallet = {
          id: nextId('w'),
          userId: create.userId,
          balance: create.balance,
          createdAt: now,
          updatedAt: now,
        };
        wallets.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; balance?: { gte?: number } };
        data: Record<string, unknown>;
      }) => {
        const row = wallets.find((w) => w.userId === where.userId);
        // The `balance >= amount` guard is the whole point: an under-funded
        // debit must match zero rows, not write a negative balance.
        if (!row) return { count: 0 };
        const gte = where.balance?.gte;
        if (gte !== undefined && row.balance < gte) return { count: 0 };
        const rest = applyNumericOps(row, data);
        Object.assign(row, rest, { updatedAt: new Date() });
        return { count: 1 };
      },
    },

    paymentTransaction: {
      create: async ({ data }: { data: Partial<FakeTransaction> & { idempotencyKey: string } }) => {
        if (transactions.some((t) => t.idempotencyKey === data.idempotencyKey)) {
          throw new FakeUniqueConstraintError('idempotencyKey');
        }
        const now = new Date();
        const row = {
          providerTransactionId: null,
          creditsGranted: null,
          modelId: null,
          tier: null,
          status: 'PENDING',
          confirmedAt: null,
          metadata: null,
          modelShareCents: null,
          platformShareCents: null,
          payoutId: null,
          ...data,
          id: nextId('tx'),
          createdAt: now,
          updatedAt: now,
        } as FakeTransaction;
        transactions.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Where }) => findTx(where) ?? null,
      update: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const row = findTx(where);
        if (!row) throw new Error('record not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const matched = transactions.filter((t) => txMatches(t, where));
        for (const row of matched) {
          Object.assign(row, data, { updatedAt: new Date() });
        }
        return { count: matched.length };
      },
      findMany: async ({ where }: { where?: Where } = {}) =>
        transactions.filter((t) => (where ? txMatches(t, where) : true)),
      count: async ({ where }: { where?: Where } = {}) =>
        transactions.filter((t) => (where ? txMatches(t, where) : true)).length,
      /** Only the `_sum: { modelShareCents }` shape the balance query uses. */
      aggregate: async ({ where }: { where?: Where } = {}) => {
        const matched = transactions.filter((t) => (where ? txMatches(t, where) : true));
        if (matched.length === 0) return { _sum: { modelShareCents: null } };
        return {
          _sum: {
            modelShareCents: matched.reduce((sum, t) => sum + (t.modelShareCents ?? 0), 0),
          },
        };
      },
      /** Only the `by: ['modelId'] + _sum` shape the payout run uses. */
      groupBy: async ({ where }: { by: string[]; where?: Where; _sum?: unknown }) => {
        const matched = transactions.filter((t) => (where ? txMatches(t, where) : true));
        const totals = new Map<string | null, number>();
        for (const row of matched) {
          totals.set(row.modelId, (totals.get(row.modelId) ?? 0) + (row.modelShareCents ?? 0));
        }
        return [...totals].map(([modelId, sum]) => ({
          modelId,
          _sum: { modelShareCents: sum },
        }));
      },
    },

    payout: {
      create: async ({ data }: { data: Partial<FakePayout> & { idempotencyKey: string } }) => {
        if (payouts.some((p) => p.idempotencyKey === data.idempotencyKey)) {
          throw new FakeUniqueConstraintError('idempotencyKey');
        }
        const row = {
          status: 'PENDING',
          providerPayoutId: null,
          failureReason: null,
          completedAt: null,
          ...data,
          id: nextId('po'),
          createdAt: new Date(),
        } as FakePayout;
        payouts.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Where }) => {
        if (where.id !== undefined) return payouts.find((p) => p.id === where.id) ?? null;
        if (where.idempotencyKey !== undefined) {
          return payouts.find((p) => p.idempotencyKey === where.idempotencyKey) ?? null;
        }
        return null;
      },
      findMany: async ({
        where,
        skip = 0,
        take,
      }: { where?: Where; orderBy?: unknown; skip?: number; take?: number } = {}) => {
        const matched = payouts
          .filter((p) => (where ? payoutMatches(p, where) : true))
          // Only the `createdAt: 'desc'` ordering the listing endpoint uses.
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matched.slice(skip, take === undefined ? undefined : skip + take);
      },
      count: async ({ where }: { where?: Where } = {}) =>
        payouts.filter((p) => (where ? payoutMatches(p, where) : true)).length,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = payouts.find((p) => p.id === where.id);
        if (!row) throw new Error('record not found');
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const matched = payouts.filter((p) => payoutMatches(p, where));
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      },
    },

    subscription: {
      findUnique: async ({ where }: { where: Where }) => {
        const key = where.subscriberId_modelId as
          | { subscriberId: string; modelId: string }
          | undefined;
        if (key) {
          return (
            subscriptions.find(
              (s) => s.subscriberId === key.subscriberId && s.modelId === key.modelId,
            ) ?? null
          );
        }
        return subscriptions.find((s) => s.id === where.id) ?? null;
      },
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: Where;
        update: Partial<FakeSubscription>;
        create: Partial<FakeSubscription> & { subscriberId: string; modelId: string };
      }) => {
        const key = where.subscriberId_modelId as { subscriberId: string; modelId: string };
        const existing = subscriptions.find(
          (s) => s.subscriberId === key.subscriberId && s.modelId === key.modelId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { ...create, id: nextId('sub') } as FakeSubscription;
        subscriptions.push(row);
        return row;
      },
    },

    auditLog: {
      create: async ({ data }: { data: Partial<FakeAudit> }) => {
        const row = {
          actorId: null,
          metadata: null,
          ...data,
          id: nextId('log'),
          createdAt: new Date(),
        } as FakeAudit;
        auditLogs.push(row);
        return row;
      },
      findMany: async ({ where }: { where?: Where } = {}) =>
        auditLogs.filter((l) => {
          if (where?.action !== undefined && l.action !== where.action) return false;
          if (where?.entity !== undefined && l.entity !== where.entity) return false;
          return true;
        }),
    },

    /** Interactive transaction: runs the callback against this same client. */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(client),

    // Direct access to the backing arrays for assertions and seeding.
    __users: users,
    __profiles: profiles,
    __content: content,
    __accesses: accesses,
    __wallets: wallets,
    __transactions: transactions,
    __subscriptions: subscriptions,
    __payouts: payouts,
    __auditLogs: auditLogs,
  };

  return client;
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;

export function createFakeEmailer(): Emailer {
  return { sendVerificationEmail: vi.fn(async () => {}) };
}

/** Seed a ModelProfile so a model can be subscribed to (and, optionally, paid). */
export function seedProfile(prisma: FakePrisma, userId: string, payoutEmail?: string): FakeProfile {
  const row: FakeProfile = {
    id: `mp_${userId}`,
    userId,
    payoutEmail: payoutEmail ?? null,
    updatedAt: new Date(),
  };
  prisma.__profiles.push(row);
  return row;
}

/** Seed a published Content row for a model. */
export function seedContent(
  prisma: FakePrisma,
  overrides: Partial<FakeContent> & { modelId: string },
): FakeContent {
  const n = prisma.__content.length + 1;
  const row: FakeContent = {
    id: `c_seed_${n}`,
    title: `Seeded ${n}`,
    type: 'IMAGE',
    tier: 'STANDARD',
    storageKey: `content/${overrides.modelId}/seed_${n}.jpg`,
    mimeType: 'image/jpeg',
    isPublished: true,
    deletedAt: null,
    createdAt: new Date(Date.now() + n),
    ...overrides,
  };
  prisma.__content.push(row);
  return row;
}

/** Seed a wallet with a starting balance. */
export function seedWallet(prisma: FakePrisma, userId: string, balance: number): FakeWallet {
  const now = new Date();
  const row: FakeWallet = {
    id: `w_seed_${prisma.__wallets.length + 1}`,
    userId,
    balance,
    createdAt: now,
    updatedAt: now,
  };
  prisma.__wallets.push(row);
  return row;
}

/**
 * Seed a CONFIRMED subscription transaction already carrying its revenue split
 * — i.e. exactly what a payment webhook leaves behind, which is the only input
 * a payout run reads.
 */
export function seedEarning(
  prisma: FakePrisma,
  overrides: Partial<FakeTransaction> & { modelId: string; modelShareCents: number },
): FakeTransaction {
  const n = prisma.__transactions.length + 1;
  const now = new Date();
  const amount = overrides.amount ?? Math.round(overrides.modelShareCents / 0.8);
  const row: FakeTransaction = {
    id: `tx_seed_${n}`,
    userId: `u_sub_${n}`,
    type: 'SUBSCRIPTION',
    provider: 'WOOVI',
    providerTransactionId: `woovi_tx_seed_${n}`,
    idempotencyKey: `sub_seed_${n}`,
    amount,
    currency: 'BRL',
    creditsGranted: null,
    tier: 'STANDARD',
    status: 'CONFIRMED',
    confirmedAt: now,
    metadata: null,
    platformShareCents: amount - overrides.modelShareCents,
    payoutId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  prisma.__transactions.push(row);
  return row;
}

/** Seed a MODEL user directly, for payout tests that don't need the auth flow. */
export function seedModel(prisma: FakePrisma, id: string, email: string): FakeUser {
  const now = new Date();
  const row: FakeUser = {
    id,
    email,
    passwordHash: 'seeded',
    role: 'MODEL',
    displayName: email,
    isVerified: true,
    verifyToken: null,
    verifyTokenExpiresAt: null,
    refreshTokenHash: null,
    createdAt: now,
    updatedAt: now,
  };
  prisma.__users.push(row);
  return row;
}
