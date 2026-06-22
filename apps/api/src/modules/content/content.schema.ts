// Request validation schemas (Zod) for the content module.
//
// Multipart fields arrive as strings, so the upload-metadata schema coerces
// `ppvPriceCents` from its string form and trims text inputs (same manual
// `safeParse`-at-the-handler approach used by auth/onboarding). The publish and
// list schemas validate JSON body / query strings respectively.
import { z } from 'zod';
import { CONTENT_TIERS, CONTENT_TYPES } from '@creator-platform/shared';

/** Metadata accompanying an upload (the file itself is validated separately). */
export const uploadMetadataSchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(200, 'title max 200 chars'),
  description: z
    .string()
    .trim()
    .max(2000, 'description max 2000 chars')
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : v)),
  type: z.enum(CONTENT_TYPES),
  tier: z.enum(CONTENT_TIERS).default('STANDARD'),
  // Optional PPV price. From multipart it's a string; normalise blank/absent to
  // undefined (not PPV), otherwise coerce to an integer of at least 100 cents.
  ppvPriceCents: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : Number(v)),
    z
      .number({ message: 'ppvPriceCents must be a number' })
      .int('ppvPriceCents must be an integer')
      .min(100, 'ppvPriceCents must be at least 100')
      .optional(),
  ),
});
export type UploadMetadataInput = z.infer<typeof uploadMetadataSchema>;

export const publishSchema = z.object({
  publish: z.boolean(),
});
export type PublishInput = z.infer<typeof publishSchema>;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  type: z.enum(CONTENT_TYPES).optional(),
  tier: z.enum(CONTENT_TIERS).optional(),
});
export type ListQueryInput = z.infer<typeof listQuerySchema>;
