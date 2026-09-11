// Request validation for the generation module (Zod, manual `safeParse` at the
// handler — the same approach every module before it uses).
//
// Two things deliberately absent from every schema here: a cost and a
// subscriber id. Cost is resolved from the server-side catalog (a client
// chooses WHAT to generate, never FOR HOW MUCH — same rule as Session 05's
// checkout), and the subscriber is the verified JWT's `userId`.
import { z } from 'zod';

/** Upper bound on a custom prompt — enough for a scene, not for an essay. */
export const CUSTOM_PROMPT_MAX_LENGTH = 500;

/** Default / maximum page size for the cursor-paginated gallery read. */
export const GENERATION_PAGE_SIZE_DEFAULT = 20;
export const GENERATION_PAGE_SIZE_MAX = 50;

const modelId = z.string().trim().min(1, 'modelId is required').max(64);

/**
 * A discriminated union on `mode`, so "custom with no customPrompt" and
 * "preset with no presetId" are shape errors (400) rather than something the
 * service has to sort out — and a preset request cannot smuggle a customPrompt
 * alongside its presetId.
 */
export const createGenerationSchema = z.discriminatedUnion('mode', [
  z
    .object({
      modelId,
      mode: z.literal('preset'),
      presetId: z.string().trim().min(1, 'presetId is required').max(64),
    })
    .strict(),
  z
    .object({
      modelId,
      mode: z.literal('custom'),
      customPrompt: z
        .string()
        .trim()
        .min(1, 'customPrompt is required')
        .max(CUSTOM_PROMPT_MAX_LENGTH, `customPrompt max ${CUSTOM_PROMPT_MAX_LENGTH} chars`),
    })
    .strict(),
]);
export type CreateGenerationInput = z.infer<typeof createGenerationSchema>;

export const generationIdParamsSchema = z.object({
  id: z.string().trim().min(1, 'id is required').max(64),
});
export type GenerationIdParams = z.infer<typeof generationIdParamsSchema>;

/**
 * Cursor pagination, never offset: `before` is the id of the oldest job the
 * client already holds — the same shape as the messaging history read.
 */
export const generationListQuerySchema = z.object({
  before: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(GENERATION_PAGE_SIZE_MAX)
    .default(GENERATION_PAGE_SIZE_DEFAULT),
});
export type GenerationListQuery = z.infer<typeof generationListQuerySchema>;
