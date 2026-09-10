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
  /** Session 06.5 — "will this renew", kept apart from `status`. */
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
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

export interface FakeConversation {
  id: string;
  subscriberId: string;
  modelId: string;
  lastMessageAt: Date | null;
  createdAt: Date;
}

export interface FakeMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string | null;
  attachmentType: 'IMAGE' | 'VIDEO' | null;
  /** Persisted, never serialized — the suite asserts it never leaves. */
  attachmentStorageKey: string | null;
  attachmentMimeType: string | null;
  attachmentSizeBytes: number | null;
  readAt: Date | null;
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
  const conversations: FakeConversation[] = [];
  const messages: FakeMessage[] = [];
  /**
   * Per-delegate-method call counter. The conversation list must stay O(1) in
   * queries however many conversations a user has, and the only honest way to
   * assert that is to count the calls the service actually issues.
   */
  const calls: Record<string, number> = {};
  const track = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
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

  /**
   * Match a subscription against the `where` shapes the renewal sweep uses:
   * scalar equality, `{ in: [...] }` on id, and `lt`/`lte`/`gte`/`gt` date
   * ranges on `currentPeriodEnd`. The range operators are what make each
   * transition pass conditional — the same property the real index serves.
   */
  const subMatches = (sub: FakeSubscription, where: Where): boolean => {
    for (const [key, condition] of Object.entries(where)) {
      const value = (sub as unknown as Record<string, unknown>)[key];
      if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
        const op = condition as {
          in?: unknown[];
          lt?: Date;
          lte?: Date;
          gt?: Date;
          gte?: Date;
        };
        if (Array.isArray(op.in) && !op.in.includes(value)) return false;
        const when = value instanceof Date ? value.getTime() : NaN;
        if (op.lt !== undefined && !(when < op.lt.getTime())) return false;
        if (op.lte !== undefined && !(when <= op.lte.getTime())) return false;
        if (op.gt !== undefined && !(when > op.gt.getTime())) return false;
        if (op.gte !== undefined && !(when >= op.gte.getTime())) return false;
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

  /**
   * Match a message against the `where` shapes the messaging module issues:
   * scalar equality, `{ in: [...] }` on conversationId, and `{ not: ... }` /
   * explicit `null` on senderId and readAt.
   */
  const messageMatches = (m: FakeMessage, where: Where): boolean => {
    for (const [key, condition] of Object.entries(where)) {
      const value = (m as unknown as Record<string, unknown>)[key];
      if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
        const op = condition as { in?: unknown[]; not?: unknown };
        if (Array.isArray(op.in) && !op.in.includes(value)) return false;
        if ('not' in op && value === op.not) return false;
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
      /** Only the `orderBy: { createdAt: 'desc' }` shape the sweep uses. */
      findFirst: async ({
        where,
        orderBy,
      }: { where?: Where; orderBy?: { createdAt?: 'asc' | 'desc' } } = {}) => {
        const matched = transactions.filter((t) => (where ? txMatches(t, where) : true));
        if (orderBy?.createdAt === 'desc') {
          matched.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return matched[0] ?? null;
      },
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
        const now = new Date();
        const row = {
          cancelAtPeriodEnd: false,
          createdAt: now,
          updatedAt: now,
          ...create,
          id: nextId('sub'),
        } as FakeSubscription;
        subscriptions.push(row);
        return row;
      },
      findMany: async ({
        where,
        orderBy,
      }: { where?: Where; orderBy?: { currentPeriodEnd?: 'asc' | 'desc' } } = {}) => {
        const matched = subscriptions.filter((sub) => (where ? subMatches(sub, where) : true));
        if (orderBy?.currentPeriodEnd === 'desc') {
          matched.sort((a, b) => b.currentPeriodEnd.getTime() - a.currentPeriodEnd.getTime());
        }
        return matched;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeSubscription>;
      }) => {
        const row = subscriptions.find((sub) => sub.id === where.id);
        if (!row) throw new Error('record not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        // Conditional by construction: the sweep's `where` carries the status
        // being moved *from*, so a re-run matches zero rows here exactly as it
        // would in Postgres.
        const matched = subscriptions.filter((sub) => subMatches(sub, where));
        for (const row of matched) Object.assign(row, data, { updatedAt: new Date() });
        return { count: matched.length };
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


    // ── Messaging (Session 07) ───────────────────────────────────────────────
    conversation: {
      findUnique: async ({ where }: { where: Where }) => {
        track('conversation.findUnique');
        const pair = where.subscriberId_modelId as
          | { subscriberId: string; modelId: string }
          | undefined;
        if (pair) {
          return (
            conversations.find(
              (c) => c.subscriberId === pair.subscriberId && c.modelId === pair.modelId,
            ) ?? null
          );
        }
        return conversations.find((c) => c.id === where.id) ?? null;
      },
      /**
       * Only the conversation-list shape: `OR` on the two participant columns,
       * `lastMessageAt desc nulls last`, and both participants joined in.
       */
      findMany: async ({
        where,
        orderBy,
        include,
      }: {
        where: Where;
        orderBy?: { lastMessageAt?: { sort: 'asc' | 'desc'; nulls?: 'first' | 'last' } };
        include?: Record<string, unknown>;
      }) => {
        track('conversation.findMany');
        const or = (where.OR ?? []) as Where[];
        let rows = conversations.filter((c) =>
          or.length === 0
            ? true
            : or.some((clause) =>
                Object.entries(clause).every(
                  ([key, value]) => (c as unknown as Record<string, unknown>)[key] === value,
                ),
              ),
        );
        if (orderBy?.lastMessageAt) {
          const dir = orderBy.lastMessageAt.sort === 'asc' ? 1 : -1;
          rows = [...rows].sort((a, b) => {
            // NULLS LAST: an empty conversation sorts below every active one,
            // whichever direction the timestamps are ordered in.
            if (a.lastMessageAt === null && b.lastMessageAt === null) return 0;
            if (a.lastMessageAt === null) return 1;
            if (b.lastMessageAt === null) return -1;
            return (a.lastMessageAt.getTime() - b.lastMessageAt.getTime()) * dir;
          });
        }
        if (!include) return rows;
        return rows.map((row) => ({
          ...row,
          subscriber: users.find((u) => u.id === row.subscriberId) ?? null,
          model: users.find((u) => u.id === row.modelId) ?? null,
        }));
      },
      create: async ({ data }: { data: { subscriberId: string; modelId: string } }) => {
        track('conversation.create');
        // One conversation per pair — UNIQUE in Postgres, so the fake refuses a
        // duplicate here rather than letting the service decide.
        if (
          conversations.some(
            (c) => c.subscriberId === data.subscriberId && c.modelId === data.modelId,
          )
        ) {
          throw new FakeUniqueConstraintError('subscriberId_modelId');
        }
        const row: FakeConversation = {
          id: nextId('conv'),
          subscriberId: data.subscriberId,
          modelId: data.modelId,
          lastMessageAt: null,
          createdAt: new Date(),
        };
        conversations.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeConversation>;
      }) => {
        track('conversation.update');
        const row = conversations.find((c) => c.id === where.id);
        if (!row) throw new Error('record not found');
        Object.assign(row, data);
        return row;
      },
    },

    message: {
      create: async ({ data }: { data: Partial<FakeMessage> & { conversationId: string } }) => {
        track('message.create');
        const row: FakeMessage = {
          senderId: '',
          body: null,
          attachmentType: null,
          attachmentStorageKey: null,
          attachmentMimeType: null,
          attachmentSizeBytes: null,
          readAt: null,
          ...data,
          id: nextId('msg'),
          // Monotonic per insert so ordering is deterministic even when several
          // messages land inside the same millisecond.
          createdAt: new Date(Date.now() + seq),
        };
        // The CHECK constraint, enforced where Postgres enforces it: a message
        // with neither a body nor an attachment must not become a row.
        if (row.body === null && row.attachmentType === null) {
          throw new Error('violates check constraint "Message_body_or_attachment_present"');
        }
        messages.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        track('message.findUnique');
        return messages.find((m) => m.id === where.id) ?? null;
      },
      /**
       * Two shapes: the cursor-paginated history read, and the one
       * `distinct: ['conversationId']` read that fetches every conversation's
       * newest message at once (Postgres DISTINCT ON).
       */
      findMany: async ({
        where,
        orderBy,
        take,
        cursor,
        skip = 0,
        distinct,
      }: {
        where: Where;
        orderBy?: Array<Record<string, 'asc' | 'desc'>>;
        take?: number;
        cursor?: { id: string };
        skip?: number;
        distinct?: string[];
        select?: Record<string, boolean>;
      }) => {
        track('message.findMany');
        let rows = messages.filter((m) => messageMatches(m, where));
        for (const clause of [...(orderBy ?? [])].reverse()) {
          const [field, dir] = Object.entries(clause)[0];
          const sign = dir === 'asc' ? 1 : -1;
          rows = [...rows].sort((a, b) => {
            const av = (a as unknown as Record<string, unknown>)[field];
            const bv = (b as unknown as Record<string, unknown>)[field];
            if (av instanceof Date && bv instanceof Date) {
              return (av.getTime() - bv.getTime()) * sign;
            }
            return String(av).localeCompare(String(bv)) * sign;
          });
        }
        if (distinct) {
          const seen = new Set<string>();
          rows = rows.filter((row) => {
            const key = distinct
              .map((field) => String((row as unknown as Record<string, unknown>)[field]))
              .join('\u0000');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (cursor) {
          const at = rows.findIndex((m) => m.id === cursor.id);
          // A cursor outside this result set pages nothing, which is exactly
          // what a cursor from another conversation must do.
          rows = at === -1 ? [] : rows.slice(at + skip);
        }
        return take === undefined ? rows : rows.slice(0, take);
      },
      /** Only the `by: ['conversationId'] + _count` unread-count shape. */
      groupBy: async ({ where }: { by: string[]; where?: Where; _count?: unknown }) => {
        track('message.groupBy');
        const matched = messages.filter((m) => (where ? messageMatches(m, where) : true));
        const totals = new Map<string, number>();
        for (const row of matched) {
          totals.set(row.conversationId, (totals.get(row.conversationId) ?? 0) + 1);
        }
        return [...totals].map(([conversationId, count]) => ({
          conversationId,
          _count: { _all: count },
        }));
      },
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        track('message.updateMany');
        // Conditional by construction: the `where` names `readAt: null`, so a
        // second mark-read matches zero rows exactly as it would in Postgres.
        const matched = messages.filter((m) => messageMatches(m, where));
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      },
      count: async ({ where }: { where?: Where } = {}) => {
        track('message.count');
        return messages.filter((m) => (where ? messageMatches(m, where) : true)).length;
      },
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
    __conversations: conversations,
    __messages: messages,
    /** Per-delegate call counts, for the "no N+1" assertions. */
    __calls: calls,
    __resetCalls: () => {
      for (const key of Object.keys(calls)) delete calls[key];
    },
  };

  return client;
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;

export function createFakeEmailer(): Emailer {
  return {
    sendVerificationEmail: vi.fn(async () => {}),
    sendRenewalReminderEmail: vi.fn(async () => {}),
  };
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

/**
 * Seed a Subscription directly — what a confirmed payment leaves behind, which
 * is the only input the renewal sweep reads.
 */
export function seedSubscription(
  prisma: FakePrisma,
  overrides: Partial<FakeSubscription> & { subscriberId: string; modelId: string },
): FakeSubscription {
  const now = new Date();
  const row: FakeSubscription = {
    id: `sub_seed_${prisma.__subscriptions.length + 1}`,
    tier: 'STANDARD',
    status: 'ACTIVE',
    provider: 'WOOVI',
    providerSubscriptionId: null,
    currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  prisma.__subscriptions.push(row);
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

/** Seed a conversation directly, skipping the create endpoint. */
export function seedConversation(
  prisma: FakePrisma,
  overrides: Partial<FakeConversation> & { subscriberId: string; modelId: string },
): FakeConversation {
  const row: FakeConversation = {
    id: `conv_seed_${prisma.__conversations.length + 1}`,
    lastMessageAt: null,
    createdAt: new Date(),
    ...overrides,
  };
  prisma.__conversations.push(row);
  return row;
}

/** Seed a message directly, for history/read-receipt tests. */
export function seedMessage(
  prisma: FakePrisma,
  overrides: Partial<FakeMessage> & { conversationId: string; senderId: string },
): FakeMessage {
  const n = prisma.__messages.length + 1;
  const row: FakeMessage = {
    id: `msg_seed_${n}`,
    body: `Seeded ${n}`,
    attachmentType: null,
    attachmentStorageKey: null,
    attachmentMimeType: null,
    attachmentSizeBytes: null,
    readAt: null,
    // Spaced so ordering is deterministic without relying on clock resolution.
    createdAt: new Date(Date.now() + n * 1000),
    ...overrides,
  };
  prisma.__messages.push(row);
  const conversation = prisma.__conversations.find((c) => c.id === row.conversationId);
  if (conversation) conversation.lastMessageAt = row.createdAt;
  return row;
}
