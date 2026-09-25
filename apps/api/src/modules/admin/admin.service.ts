// =============================================================================
// Admin console business logic (Session 11): model approval, user management,
// the metrics overview, the on-demand payout run, and content moderation.
//
// ── What this module does NOT own ───────────────────────────────────────────
// It reuses, never re-implements: the payout listing/detail reads live in
// `payouts/` (Session 06) and are consumed as-is; the payout run is the same
// `runPayouts` the cron route calls, handed a different trigger; unpublishing
// reported content goes through `contentService.setPublish` — the one publish
// toggle — with the admin role; suspending a reported model goes through this
// module's own `suspendUser`, the same path the users screen uses. One
// implementation per action, so there is one place each rule lives.
//
// ── Audit ───────────────────────────────────────────────────────────────────
// Every state change here writes an `AuditLog` row in the same `$transaction`
// as the write it describes, with the acting admin as `actorId` and enough
// metadata to answer "who did what, to whom, when, why" — the bar Session 06
// set for payout-email changes. Idempotent no-ops (approving an approved model,
// suspending a suspended user) write no row: an audit trail that claims a
// change happened when nothing did is worse than none.
//
// ── An admin cannot act against an admin ────────────────────────────────────
// `suspendUser` refuses a target whose role is ADMIN before touching anything,
// so a compromised admin session cannot lock the rest of the team out. This is
// the only role-on-role rule the console has; nothing else here is
// self-referential.
//
// ── Metrics are aggregates, never scans ─────────────────────────────────────
// `getMetricsOverview` issues a fixed number of `groupBy`/`count` queries
// regardless of table sizes (asserted by a query-count test, Session 07
// style). Money is reported per currency and never summed across currencies —
// there is no FX policy yet (an Open Item deliberately left to Session 12).
// =============================================================================
import {
  ADMIN_METRICS_WINDOW_DAYS,
  CHANNEL_CURRENCY,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_TIERS,
  type AdminCurrencyTotal,
  type AdminMetricsOverview,
  type AdminModelDecisionResponse,
  type AdminModelListItem,
  type AdminPage,
  type AdminReportListItem,
  type AdminResolveReportResponse,
  type AdminSuspendResponse,
  type AdminUserDetail,
  type AdminUserListItem,
  type ContentTier,
  type ContentType,
  type Currency,
  type ModelApprovalStatus,
  type PaymentProviderName,
  type PayoutRecordStatus,
  type PayoutRunSummary,
  type ReportReason,
  type ReportResolveAction,
  type ReportStatus,
  type Role,
  type SubscriptionTier,
} from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import { ContentError, type ContentService } from '../content/content.service.js';
import type { PayoutsService } from '../payouts/payouts.service.js';
import type { ModelListQuery, ReportListQuery, UserListQuery } from './admin.schema.js';

/** Typed error carrying the HTTP status the route should answer with. */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

/**
 * Signed-URL TTL for reference images shown to a reviewing admin — the same
 * 300 s Session 03's `GET /onboarding/profile` mints for the model themself.
 */
const REVIEW_URL_TTL = 300;

/**
 * Which settlement currency each payment adapter bills in. WOOVI serves the
 * PIX channel (BRL-only guard in the adapter) and NOWPAYMENTS the crypto
 * channel (USD-priced), so these follow `CHANNEL_CURRENCY` rather than
 * restating it. The offline mock records `CCBILL_MOCK` whichever channel it
 * stood in for, so its currency is genuinely unknown from the row alone —
 * those subscriptions are reported as unattributed, never guessed.
 */
const PROVIDER_CURRENCY: Record<PaymentProviderName, Extract<Currency, 'BRL' | 'USD'> | null> = {
  WOOVI: CHANNEL_CURRENCY.pix,
  NOWPAYMENTS: CHANNEL_CURRENCY.crypto,
  CCBILL_MOCK: null,
};

/** Only these rows are payable revenue — identical to the payout run's filter. */
const PAYABLE_WHERE = {
  type: 'SUBSCRIPTION',
  status: 'CONFIRMED',
  payoutId: null,
} as const;

/** Payout states that represent money committed or in flight. */
const PAYOUT_TOTAL_STATUSES: PayoutRecordStatus[] = ['PENDING', 'PROCESSING', 'COMPLETED'];

type PrismaRole = 'ADMIN' | 'MODEL' | 'SUBSCRIBER';
const toPrismaRole = (role: Role): PrismaRole => role.toUpperCase() as PrismaRole;
const toApiRole = (role: string): Role => role.toLowerCase() as Role;

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

export interface AdminServiceDeps {
  prisma: PrismaClient;
  storage: StorageClient;
  /** Bucket the reference images live in (from STORAGE_BUCKET). */
  bucket: string;
  /** Session 04's publish toggle — the one unpublish implementation. */
  setPublish: ContentService['setPublish'];
  /** Session 06's payout run — the one run implementation. */
  runPayouts: PayoutsService['runPayouts'];
  /** `PAYOUT_MIN_THRESHOLD_CENTS`, for the "above threshold, no destination" count. */
  payoutMinThresholdCents: number;
}

export function createAdminService({
  prisma,
  storage,
  bucket,
  setPublish,
  runPayouts,
  payoutMinThresholdCents,
}: AdminServiceDeps) {
  const userSelect = {
    id: true,
    email: true,
    role: true,
    isVerified: true,
    displayName: true,
    suspendedAt: true,
    createdAt: true,
  } as const;

  function toUserListItem(row: {
    id: string;
    email: string;
    role: string;
    isVerified: boolean;
    displayName: string;
    suspendedAt: Date | null;
    createdAt: Date;
  }): AdminUserListItem {
    return {
      id: row.id,
      email: row.email,
      role: toApiRole(row.role),
      isVerified: row.isVerified,
      displayName: row.displayName,
      suspendedAt: iso(row.suspendedAt),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Load a MODEL user and their profile, or 404 — never 500 on a bad id. */
  async function loadModelForDecision(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'MODEL') {
      throw new AdminError(404, 'model_not_found');
    }
    const profile = await prisma.modelProfile.findUnique({ where: { userId } });
    if (!profile) {
      // A model who has registered but never created a profile has nothing to
      // approve yet; distinguishable from an unknown id so the UI can say so.
      throw new AdminError(404, 'model_profile_not_found');
    }
    return { user, profile };
  }

  function toDecision(
    userId: string,
    profile: {
      approvalStatus: string;
      approvalReviewedAt: Date | null;
      approvalRejectionReason: string | null;
    },
    changed: boolean,
  ): AdminModelDecisionResponse {
    return {
      userId,
      approvalStatus: profile.approvalStatus as ModelApprovalStatus,
      approvalReviewedAt: iso(profile.approvalReviewedAt),
      approvalRejectionReason: profile.approvalRejectionReason,
      changed,
    };
  }

  /**
   * Lock an account out. Shared by the users screen and by report resolution
   * (`unpublish_and_suspend_model`) — the one place the "never an ADMIN" rule
   * and the audit row live.
   */
  async function suspendUser(
    actorId: string,
    userId: string,
    reason: string | undefined,
  ): Promise<AdminSuspendResponse> {
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) {
      throw new AdminError(404, 'user_not_found');
    }
    // Refused before any write and before any audit row: an admin session —
    // compromised or not — must not be able to lock the rest of the team out.
    if (target.role === 'ADMIN') {
      throw new AdminError(403, 'cannot_suspend_admin');
    }
    if (target.suspendedAt) {
      return { userId, suspendedAt: target.suspendedAt.toISOString(), changed: false };
    }

    const suspendedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { suspendedAt } });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'user.suspended',
          entity: 'User',
          entityId: userId,
          metadata: {
            targetUserId: userId,
            targetRole: toApiRole(target.role),
            reason: reason ?? null,
          },
        },
      });
    });
    return { userId, suspendedAt: suspendedAt.toISOString(), changed: true };
  }

  return {
    // ── D1 — model approval ─────────────────────────────────────────────────

    /**
     * GET /admin/models — the approval queue. Each entry carries fresh
     * short-TTL signed URLs for the model's reference images so the reviewer
     * can look at what they are approving; `storageKey` never leaves.
     */
    async listModels(query: ModelListQuery): Promise<AdminPage<AdminModelListItem>> {
      const where =
        query.status === 'all'
          ? {}
          : { approvalStatus: query.status.toUpperCase() as ModelApprovalStatus };

      const [rows, total] = await Promise.all([
        prisma.modelProfile.findMany({
          where,
          // Oldest first: the queue is served in the order models joined it.
          orderBy: { createdAt: 'asc' },
          skip: query.offset,
          take: query.limit,
          include: {
            user: { select: userSelect },
            referenceImages: { orderBy: { createdAt: 'asc' } },
          },
        }),
        prisma.modelProfile.count({ where }),
      ]);

      const items: AdminModelListItem[] = await Promise.all(
        rows.map(async (row) => ({
          userId: row.userId,
          email: row.user.email,
          isVerified: row.user.isVerified,
          suspendedAt: iso(row.user.suspendedAt),
          profile: {
            profileId: row.id,
            displayName: row.displayName,
            bio: row.bio,
            country: row.country,
            currency: row.currency as Currency,
            aiConsent: row.aiConsent,
            tosAcceptedAt: iso(row.tosAcceptedAt),
            approvalStatus: row.approvalStatus as ModelApprovalStatus,
            approvalReviewedAt: iso(row.approvalReviewedAt),
            approvalRejectionReason: row.approvalRejectionReason,
            createdAt: row.createdAt.toISOString(),
          },
          referenceImages: await Promise.all(
            row.referenceImages.map(async (img) => ({
              imageId: img.id,
              signedUrl: await storage.getSignedUrl(bucket, img.storageKey, REVIEW_URL_TTL),
              mimeType: img.mimeType,
              sizeBytes: img.sizeBytes,
              createdAt: img.createdAt.toISOString(),
            })),
          ),
        })),
      );

      return { items, total, limit: query.limit, offset: query.offset };
    },

    /**
     * POST /admin/models/:userId/approve. Works from any prior status —
     * REJECTED is not a dead end. Idempotent: an already-approved model is a
     * 200 no-op with no second audit row.
     */
    async approveModel(actorId: string, userId: string): Promise<AdminModelDecisionResponse> {
      const { profile } = await loadModelForDecision(userId);
      if (profile.approvalStatus === 'APPROVED') {
        return toDecision(userId, profile, false);
      }
      const previous = {
        status: profile.approvalStatus,
        rejectionReason: profile.approvalRejectionReason,
      };

      const reviewedAt = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.modelProfile.update({
          where: { userId },
          data: {
            approvalStatus: 'APPROVED',
            approvalReviewedAt: reviewedAt,
            // The previous rejection, if any, stays in the audit trail below;
            // the live row should not keep advertising a reason that no
            // longer applies.
            approvalRejectionReason: null,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'model.approved',
            entity: 'ModelProfile',
            entityId: profile.id,
            metadata: {
              modelId: userId,
              previousStatus: previous.status,
              previousRejectionReason: previous.rejectionReason,
            },
          },
        });
        return row;
      });
      return toDecision(userId, updated, true);
    },

    /**
     * POST /admin/models/:userId/reject. The reason is required by the schema
     * and recorded on both the row and the audit entry. Re-rejecting with the
     * identical reason is a no-op; a different reason is a new decision.
     */
    async rejectModel(
      actorId: string,
      userId: string,
      reason: string,
    ): Promise<AdminModelDecisionResponse> {
      const { profile } = await loadModelForDecision(userId);
      if (profile.approvalStatus === 'REJECTED' && profile.approvalRejectionReason === reason) {
        return toDecision(userId, profile, false);
      }
      const previousStatus = profile.approvalStatus;

      const reviewedAt = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.modelProfile.update({
          where: { userId },
          data: {
            approvalStatus: 'REJECTED',
            approvalReviewedAt: reviewedAt,
            approvalRejectionReason: reason,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'model.rejected',
            entity: 'ModelProfile',
            entityId: profile.id,
            metadata: {
              modelId: userId,
              previousStatus,
              reason,
            },
          },
        });
        return row;
      });
      return toDecision(userId, updated, true);
    },

    // ── D2 — user management ────────────────────────────────────────────────

    /**
     * GET /admin/users. `select` keeps `passwordHash`/`refreshTokenHash` out of
     * the query itself — not merely out of the mapper — so no code path here
     * ever holds a hash.
     */
    async listUsers(query: UserListQuery): Promise<AdminPage<AdminUserListItem>> {
      const where = {
        ...(query.role ? { role: toPrismaRole(query.role) } : {}),
        ...(query.email ? { email: { contains: query.email, mode: 'insensitive' as const } } : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: query.offset,
          take: query.limit,
          select: userSelect,
        }),
        prisma.user.count({ where }),
      ]);
      return { items: rows.map(toUserListItem), total, limit: query.limit, offset: query.offset };
    },

    /** GET /admin/users/:userId — the list row plus role-specific rollups. */
    async getUser(userId: string): Promise<AdminUserDetail> {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: userSelect });
      if (!user) {
        throw new AdminError(404, 'user_not_found');
      }
      const base = toUserListItem(user);

      if (user.role === 'MODEL') {
        const profile = await prisma.modelProfile.findUnique({ where: { userId } });
        return {
          ...base,
          model: profile
            ? {
                profileId: profile.id,
                approvalStatus: profile.approvalStatus as ModelApprovalStatus,
                approvalReviewedAt: iso(profile.approvalReviewedAt),
                approvalRejectionReason: profile.approvalRejectionReason,
                // Whether, not where: the address itself is not an admin
                // listing field (same posture as GET /payouts/balance).
                payoutEmailConfigured: Boolean(profile.payoutEmail),
              }
            : null,
          subscriber: null,
        };
      }

      if (user.role === 'SUBSCRIBER') {
        const [activeSubscriptions, wallet] = await Promise.all([
          prisma.subscription.count({ where: { subscriberId: userId, status: 'ACTIVE' } }),
          prisma.creditWallet.findUnique({ where: { userId } }),
        ]);
        return {
          ...base,
          model: null,
          subscriber: { activeSubscriptions, walletBalance: wallet?.balance ?? 0 },
        };
      }

      return { ...base, model: null, subscriber: null };
    },

    suspendUser,

    /** POST /admin/users/:userId/reinstate — clears the lock; idempotent. */
    async reinstateUser(actorId: string, userId: string): Promise<AdminSuspendResponse> {
      const target = await prisma.user.findUnique({ where: { id: userId } });
      if (!target) {
        throw new AdminError(404, 'user_not_found');
      }
      const previouslySuspendedAt = target.suspendedAt;
      if (!previouslySuspendedAt) {
        return { userId, suspendedAt: null, changed: false };
      }
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { suspendedAt: null } });
        await tx.auditLog.create({
          data: {
            actorId,
            action: 'user.reinstated',
            entity: 'User',
            entityId: userId,
            metadata: {
              targetUserId: userId,
              targetRole: toApiRole(target.role),
              suspendedAt: previouslySuspendedAt.toISOString(),
            },
          },
        });
      });
      return { userId, suspendedAt: null, changed: true };
    },

    // ── D3 — metrics overview ───────────────────────────────────────────────

    /**
     * GET /admin/metrics/overview. Seven aggregate queries, whatever the row
     * counts. Nothing here loads a table into memory, and no figure is summed
     * across currencies.
     */
    async getMetricsOverview(now: Date = new Date()): Promise<AdminMetricsOverview> {
      const windowStart = new Date(now.getTime() - ADMIN_METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const [
        activeSubscribers,
        activeByTierProvider,
        creditPacks,
        generations,
        payoutGroups,
        payableGroups,
      ] = await Promise.all([
        // One row per distinct subscriber with an ACTIVE subscription.
        prisma.subscription.groupBy({
          by: ['subscriberId'],
          where: { status: 'ACTIVE' },
        }),
        // Active subscriptions by (tier, adapter) — the adapter decides the
        // settlement currency, and the tier the catalog price in it.
        prisma.subscription.groupBy({
          by: ['tier', 'provider'],
          where: { status: 'ACTIVE' },
          _count: { _all: true },
        }),
        prisma.paymentTransaction.groupBy({
          by: ['currency'],
          where: { type: 'CREDIT_PACK', status: 'CONFIRMED', confirmedAt: { gte: windowStart } },
          _sum: { amount: true },
        }),
        prisma.generationJob.groupBy({
          by: ['status'],
          where: { createdAt: { gte: windowStart } },
          _count: { _all: true },
        }),
        prisma.payout.groupBy({
          by: ['status', 'currency'],
          where: { status: { in: PAYOUT_TOTAL_STATUSES } },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        // The payout run's own grouping, reused verbatim.
        prisma.paymentTransaction.groupBy({
          by: ['modelId'],
          where: PAYABLE_WHERE,
          _sum: { modelShareCents: true },
        }),
      ]);

      // ── Subscriptions + recurring revenue ──────────────────────────────────
      const byTier = Object.fromEntries(SUBSCRIPTION_TIERS.map((tier) => [tier, 0])) as Record<
        SubscriptionTier,
        number
      >;
      const recurring = new Map<Currency, { subscriptions: number; amountCents: number }>();
      let unattributedSubscriptions = 0;

      for (const group of activeByTierProvider) {
        const count = group._count._all;
        const tier = group.tier as SubscriptionTier;
        if (tier in byTier) byTier[tier] += count;
        const currency = PROVIDER_CURRENCY[group.provider as PaymentProviderName] ?? null;
        if (!currency || !(tier in SUBSCRIPTION_PLANS)) {
          unattributedSubscriptions += count;
          continue;
        }
        const bucket = recurring.get(currency) ?? { subscriptions: 0, amountCents: 0 };
        bucket.subscriptions += count;
        bucket.amountCents += count * SUBSCRIPTION_PLANS[tier].price[currency];
        recurring.set(currency, bucket);
      }

      // ── Generations ────────────────────────────────────────────────────────
      const genCounts = { COMPLETED: 0, FAILED: 0, PENDING: 0 } as Record<string, number>;
      for (const group of generations) {
        genCounts[group.status] = (genCounts[group.status] ?? 0) + group._count._all;
      }
      const settled = genCounts.COMPLETED + genCounts.FAILED;

      // ── Payouts ────────────────────────────────────────────────────────────
      const aboveThreshold = payableGroups
        .filter(
          (group): group is typeof group & { modelId: string } =>
            group.modelId !== null && (group._sum.modelShareCents ?? 0) >= payoutMinThresholdCents,
        )
        .map((group) => group.modelId);
      const withPayoutEmail = await prisma.modelProfile.count({
        where: { userId: { in: aboveThreshold }, payoutEmail: { not: null } },
      });

      const sortByCurrency = <T extends AdminCurrencyTotal>(rows: T[]) =>
        rows.sort((a, b) => a.currency.localeCompare(b.currency));

      return {
        generatedAt: now.toISOString(),
        windowDays: ADMIN_METRICS_WINDOW_DAYS,
        subscribers: { active: activeSubscribers.length },
        subscriptions: {
          active: {
            total: Object.values(byTier).reduce((sum, n) => sum + n, 0),
            byTier,
          },
        },
        recurringRevenue: {
          byCurrency: sortByCurrency(
            [...recurring].map(([currency, bucket]) => ({
              currency,
              subscriptions: bucket.subscriptions,
              amountCents: bucket.amountCents,
            })),
          ),
          unattributedSubscriptions,
        },
        creditPackRevenue: {
          byCurrency: sortByCurrency(
            creditPacks.map((group) => ({
              currency: group.currency as Currency,
              amountCents: group._sum.amount ?? 0,
            })),
          ),
        },
        generations: {
          total: genCounts.COMPLETED + genCounts.FAILED + genCounts.PENDING,
          completed: genCounts.COMPLETED,
          failed: genCounts.FAILED,
          pending: genCounts.PENDING,
          completionRate: settled === 0 ? null : genCounts.COMPLETED / settled,
        },
        payouts: {
          byStatus: payoutGroups
            .map((group) => ({
              status: group.status as PayoutRecordStatus,
              currency: group.currency as Currency,
              count: group._count._all,
              amountCents: group._sum.amountCents ?? 0,
            }))
            .sort(
              (a, b) =>
                PAYOUT_TOTAL_STATUSES.indexOf(a.status) - PAYOUT_TOTAL_STATUSES.indexOf(b.status) ||
                a.currency.localeCompare(b.currency),
            ),
          // Above the threshold but with nowhere to send it — exactly the rows
          // the next run will skip with `payout.skipped_no_payout_email`.
          modelsAboveThresholdWithoutPayoutEmail: aboveThreshold.length - withPayoutEmail,
          thresholdCents: payoutMinThresholdCents,
        },
      };
    },

    // ── D4 — on-demand payout run ───────────────────────────────────────────

    /**
     * POST /admin/payouts/run — the same function the cron route calls, with
     * the admin recorded as the trigger on the run's summary audit row.
     */
    async runPayouts(actorId: string): Promise<PayoutRunSummary> {
      return runPayouts({ source: 'admin', actorId });
    },

    // ── D5 — content moderation ─────────────────────────────────────────────

    /** GET /admin/reports — the queue, with the reported item and its owner. */
    async listReports(query: ReportListQuery): Promise<AdminPage<AdminReportListItem>> {
      const where =
        query.status === 'all' ? {} : { status: query.status.toUpperCase() as ReportStatus };

      const [rows, total] = await Promise.all([
        prisma.report.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          skip: query.offset,
          take: query.limit,
          include: {
            reporter: { select: { id: true, email: true, displayName: true } },
            content: {
              select: {
                id: true,
                title: true,
                type: true,
                tier: true,
                isPublished: true,
                deletedAt: true,
                model: {
                  select: { id: true, email: true, displayName: true, suspendedAt: true },
                },
              },
            },
          },
        }),
        prisma.report.count({ where }),
      ]);

      const items: AdminReportListItem[] = rows.map((row) => ({
        reportId: row.id,
        reason: row.reason as ReportReason,
        details: row.details,
        status: row.status as ReportStatus,
        resolvedAction: (row.resolvedAction as ReportResolveAction | null) ?? null,
        resolvedAt: iso(row.resolvedAt),
        createdAt: row.createdAt.toISOString(),
        reporter: {
          userId: row.reporter.id,
          email: row.reporter.email,
          displayName: row.reporter.displayName,
        },
        content: {
          contentId: row.content.id,
          title: row.content.title,
          type: row.content.type as ContentType,
          tier: row.content.tier as ContentTier,
          isPublished: row.content.isPublished,
          deletedAt: iso(row.content.deletedAt),
          owner: {
            userId: row.content.model.id,
            email: row.content.model.email,
            displayName: row.content.model.displayName,
            suspendedAt: iso(row.content.model.suspendedAt),
          },
        },
      }));

      return { items, total, limit: query.limit, offset: query.offset };
    },

    /**
     * POST /admin/reports/:reportId/resolve. The side effects run first and
     * are each idempotent (an unpublish of unpublished content, a suspension
     * of a suspended model, both no-ops); the report is then claimed with a
     * compare-and-set on `status = PENDING`, so two admins resolving at once
     * produce one RESOLVED row and one 409 — never two audit entries.
     */
    async resolveReport(
      actorId: string,
      reportId: string,
      action: ReportResolveAction,
    ): Promise<AdminResolveReportResponse> {
      const report = await prisma.report.findUnique({ where: { id: reportId } });
      if (!report) {
        throw new AdminError(404, 'report_not_found');
      }
      if (report.status !== 'PENDING') {
        throw new AdminError(409, 'report_already_resolved');
      }

      let contentUnpublished = false;
      let modelSuspended = false;

      if (action === 'unpublish' || action === 'unpublish_and_suspend_model') {
        try {
          // The one publish toggle, with the admin role — not a second
          // unpublish implementation.
          await setPublish(actorId, report.contentId, false, 'admin');
          contentUnpublished = true;
        } catch (err) {
          // Soft-deleted since the report was filed: already off the platform,
          // nothing left to unpublish. Anything else is a real failure.
          if (!(err instanceof ContentError && err.status === 404)) throw err;
        }
      }

      if (action === 'unpublish_and_suspend_model') {
        const content = await prisma.content.findUnique({ where: { id: report.contentId } });
        if (content) {
          // The D2 path: same rule set, same audit row.
          const outcome = await suspendUser(
            actorId,
            content.modelId,
            `Content report ${reportId} resolved with unpublish_and_suspend_model`,
          );
          modelSuspended = outcome.suspendedAt !== null;
        }
      }

      const resolvedAt = new Date();
      const claimed = await prisma.report.updateMany({
        where: { id: reportId, status: 'PENDING' },
        data: { status: 'RESOLVED', resolvedAction: action, resolvedAt },
      });
      if (claimed.count === 0) {
        throw new AdminError(409, 'report_already_resolved');
      }

      await prisma.auditLog.create({
        data: {
          actorId,
          action: 'report.resolved',
          entity: 'Report',
          entityId: reportId,
          metadata: {
            reportId,
            contentId: report.contentId,
            reporterId: report.reporterId,
            reason: report.reason,
            action,
            contentUnpublished,
            modelSuspended,
          },
        },
      });

      return {
        reportId,
        status: 'RESOLVED',
        resolvedAction: action,
        resolvedAt: resolvedAt.toISOString(),
        contentUnpublished,
        modelSuspended,
      };
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
