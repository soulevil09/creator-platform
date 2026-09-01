// Request validation for the payouts module.
//
// There is no schema for the payout *amount* anywhere: a run pays exactly what
// the ledger says is owed, and no endpoint accepts a figure from a caller.
import { z } from 'zod';

/** Pagination for the ADMIN listing. Capped so one call cannot dump the table. */
export const payoutListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PayoutListQuery = z.infer<typeof payoutListQuerySchema>;

export const payoutIdParamsSchema = z.object({
  payoutId: z.string().trim().min(1, 'payoutId is required').max(64),
});
export type PayoutIdParams = z.infer<typeof payoutIdParamsSchema>;

/**
 * The Paxum address a model's earnings are sent to. Lowercased and trimmed so
 * the UNIQUE index cannot be sidestepped by casing — two models must not be
 * able to claim `Model@Paxum.com` and `model@paxum.com` separately.
 */
export const payoutEmailSchema = z.object({
  payoutEmail: z.string().trim().toLowerCase().email('payoutEmail must be a valid email').max(254),
});
export type PayoutEmailInput = z.infer<typeof payoutEmailSchema>;
