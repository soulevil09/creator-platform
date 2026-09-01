// =============================================================================
// Revenue split — the one place the model/platform percentages are applied.
//
// Called from the payments webhook confirmation (Session 05's `$transaction`,
// extended in Session 06) so the split is stamped onto the PaymentTransaction
// at the moment the money is confirmed, not recomputed later from a percentage
// that may since have changed. That is what makes a payout auditable: the row
// records what was actually owed under the terms in force at the time.
// =============================================================================
import { DEFAULT_REVENUE_SHARE_MODEL_PCT } from '@creator-platform/shared';

export interface RevenueSplit {
  modelShareCents: number;
  platformShareCents: number;
}

/**
 * Split one confirmed payment between model and platform.
 *
 * Remainder-to-platform rounding: the model's share is rounded to the nearest
 * cent and the platform takes whatever is left, so `model + platform` always
 * equals `amountCents` exactly — no cent is ever lost or invented. (The
 * migration backs this with a CHECK constraint.)
 */
export function computeRevenueSplit(
  amountCents: number,
  modelPct: number = DEFAULT_REVENUE_SHARE_MODEL_PCT,
): RevenueSplit {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`Revenue split needs a non-negative integer amount (got ${amountCents})`);
  }
  if (!Number.isFinite(modelPct) || modelPct < 0 || modelPct > 100) {
    throw new RangeError(`Revenue share percentage must be within 0..100 (got ${modelPct})`);
  }
  const modelShareCents = Math.round((amountCents * modelPct) / 100);
  return { modelShareCents, platformShareCents: amountCents - modelShareCents };
}
