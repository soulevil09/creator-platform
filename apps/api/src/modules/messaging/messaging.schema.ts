// Request validation for the messaging module (Zod, manual `safeParse` at the
// handler — the same approach auth/onboarding/content use).
//
// Two things deliberately absent from every schema here: a sender id and a
// participant id. Both come from the verified JWT, so there is no identifier a
// client could substitute to write as, or read as, somebody else.
import { z } from 'zod';
import {
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_PAGE_SIZE_DEFAULT,
  MESSAGE_PAGE_SIZE_MAX,
} from '@creator-platform/shared';

export const modelIdParamsSchema = z.object({
  modelId: z.string().trim().min(1, 'modelId is required').max(64),
});
export type ModelIdParams = z.infer<typeof modelIdParamsSchema>;

export const conversationIdParamsSchema = z.object({
  conversationId: z.string().trim().min(1, 'conversationId is required').max(64),
});
export type ConversationIdParams = z.infer<typeof conversationIdParamsSchema>;

export const messageIdParamsSchema = z.object({
  messageId: z.string().trim().min(1, 'messageId is required').max(64),
});
export type MessageIdParams = z.infer<typeof messageIdParamsSchema>;

/**
 * Cursor pagination, never offset: `before` is the id of the oldest message the
 * client already holds. Offsets shift under concurrent inserts, and a chat is
 * append-heavy by definition.
 */
export const messageHistoryQuerySchema = z.object({
  before: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MESSAGE_PAGE_SIZE_MAX)
    .default(MESSAGE_PAGE_SIZE_DEFAULT),
});
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

/**
 * The text half of a send, for both transports: a JSON body `{ text }` and a
 * multipart `text` field validate against this same schema, so the 4000-char
 * ceiling cannot be sidestepped by picking the other content type.
 *
 * An empty/whitespace-only string collapses to `undefined` rather than being
 * stored as `""` — a blank body with no attachment is `empty_message`, decided
 * in the service, not a row the CHECK constraint would then have to argue with.
 */
export const sendMessageBodySchema = z.object({
  text: z
    .string()
    .max(MESSAGE_BODY_MAX_LENGTH, `text max ${MESSAGE_BODY_MAX_LENGTH} chars`)
    .transform((value) => {
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    })
    .optional(),
});
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;
