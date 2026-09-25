// Request validation for the admin console (Session 11).
//
// Every listing is paginated with the same envelope Session 06's payout
// listing uses (limit ≤ 100, offset ≥ 0) — no admin endpoint can dump a table.
// Free-text fields (rejection reason, suspension reason) are bounded so an
// audit row can never be made arbitrarily large.
import { z } from 'zod';
import {
  ADMIN_MODEL_STATUS_FILTERS,
  ADMIN_REPORT_STATUS_FILTERS,
  REPORT_RESOLVE_ACTIONS,
  USER_ROLES,
} from '@creator-platform/shared';

const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
};

export const userIdParamsSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required').max(64),
});
export type UserIdParams = z.infer<typeof userIdParamsSchema>;

export const reportIdParamsSchema = z.object({
  reportId: z.string().trim().min(1, 'reportId is required').max(64),
});
export type ReportIdParams = z.infer<typeof reportIdParamsSchema>;

/** GET /admin/models — the approval queue defaults to what needs a decision. */
export const modelListQuerySchema = z.object({
  status: z.enum(ADMIN_MODEL_STATUS_FILTERS).default('pending'),
  ...pagination,
});
export type ModelListQuery = z.infer<typeof modelListQuerySchema>;

/** POST /admin/models/:userId/reject — a decision against someone needs a why. */
export const rejectModelSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(1000, 'reason max 1000 chars'),
});
export type RejectModelInput = z.infer<typeof rejectModelSchema>;

/**
 * GET /admin/users. `email` is a case-insensitive substring; `role` is the API
 * vocabulary (lowercase) and mapped to the Prisma enum in the service.
 */
export const userListQuerySchema = z.object({
  role: z.enum(USER_ROLES).optional(),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : v)),
  ...pagination,
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;

/** POST /admin/users/:userId/suspend — reason optional, but bounded when given. */
export const suspendUserSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(1000, 'reason max 1000 chars')
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : v)),
});
export type SuspendUserInput = z.infer<typeof suspendUserSchema>;

/** GET /admin/reports — the moderation queue defaults to what is open. */
export const reportListQuerySchema = z.object({
  status: z.enum(ADMIN_REPORT_STATUS_FILTERS).default('pending'),
  ...pagination,
});
export type ReportListQuery = z.infer<typeof reportListQuerySchema>;

/** POST /admin/reports/:reportId/resolve. */
export const resolveReportSchema = z.object({
  action: z.enum(REPORT_RESOLVE_ACTIONS),
});
export type ResolveReportInput = z.infer<typeof resolveReportSchema>;
