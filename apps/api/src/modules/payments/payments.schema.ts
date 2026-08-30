// Request validation for the payments module.
//
// Note what is NOT in these schemas: an amount. Prices come from the catalog in
// @creator-platform/shared, keyed by tier or pack id, so a client cannot name
// its own price. The client only picks *what* it is buying and *how* it pays.
import { z } from 'zod';
import { CHECKOUT_CHANNELS, SUBSCRIPTION_TIERS } from '@creator-platform/shared';

export const subscriptionCheckoutSchema = z.object({
  modelId: z.string().trim().min(1, 'modelId is required').max(64),
  tier: z.enum(SUBSCRIPTION_TIERS),
  provider: z.enum(CHECKOUT_CHANNELS),
});
export type SubscriptionCheckoutInput = z.infer<typeof subscriptionCheckoutSchema>;

export const creditsCheckoutSchema = z.object({
  packId: z.string().trim().min(1, 'packId is required').max(64),
  provider: z.enum(CHECKOUT_CHANNELS),
});
export type CreditsCheckoutInput = z.infer<typeof creditsCheckoutSchema>;
