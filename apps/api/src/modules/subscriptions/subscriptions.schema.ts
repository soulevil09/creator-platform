// Request validation for the subscriptions module.
//
// Note what is NOT in these schemas: a subscriber id. Every endpoint here scopes
// to the caller's own `userId`, taken from the verified JWT, so there is no
// identifier a client could substitute to reach someone else's subscription.
import { z } from 'zod';

export const modelIdParamsSchema = z.object({
  modelId: z.string().trim().min(1, 'modelId is required').max(64),
});
export type ModelIdParams = z.infer<typeof modelIdParamsSchema>;
