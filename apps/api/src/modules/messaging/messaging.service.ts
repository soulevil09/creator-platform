// =============================================================================
// Private messaging business logic (Session 07).
//
// This layer owns the database, object storage and fan-out; it knows nothing
// about HTTP, multipart or WebSocket framing (the routes and the socket plugin
// wire those). Three invariants live here rather than at the edges:
//
//   1. `attachmentStorageKey` NEVER leaves this layer. Nothing that reaches a
//      client is built from it except a 60-second signed URL, minted on demand
//      by one endpoint that checks participation first. Same rule as
//      `Content.storageKey` (Session 04) and `ReferenceImage.storageKey`
//      (Session 03).
//
//   2. A non-participant gets 404, never 403. 403 confirms that the id exists,
//      which turns any conversation id into an oracle; 404 makes reading and
//      guessing indistinguishable. Same reasoning as Session 06's payout-detail
//      endpoint.
//
//   3. A subscriber's right to *send* is read live from `Subscription.status`
//      on every send, never cached from conversation-creation time. A
//      subscription that lapses mid-conversation stops the subscriber writing
//      on their very next message. The model is never gated — they must be able
//      to answer a paying customer's last message whatever happened to that
//      customer's billing afterwards — and history stays readable to both
//      parties regardless, because those messages were already paid for.
//
// The WebSocket is broadcast-only: every message is written through
// `sendMessage` below, so there is exactly one place that validates, persists,
// rate-limits and audits a write, and fan-out is a pure read-side concern.
// =============================================================================
import { createId } from '@paralleldrive/cuid2';
import {
  MESSAGE_EVENT_NEW,
  MESSAGE_PREVIEW_MAX_LENGTH,
  type ConversationListItem,
  type ConversationListResponse,
  type ConversationSummary,
  type MarkConversationReadResponse,
  type MessageAttachmentType,
  type MessageAttachmentUrlResponse,
  type MessageHistoryResponse,
  type MessageItem,
} from '@creator-platform/shared';
import type { PrismaClient } from '../../lib/prisma.js';
import type { StorageClient } from '../../lib/storage.js';
import type { ConnectionRegistry } from './connections.js';

/** Attachment signed-URL TTL — the same 60s Session 04 serves video with. */
export const ATTACHMENT_URL_TTL = 60;

/** Typed error carrying the HTTP status the route should answer with. */
export class MessagingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}

export interface MessagingServiceDeps {
  prisma: PrismaClient;
  storage: StorageClient;
  /** Bucket to write attachments into (from STORAGE_BUCKET). */
  bucket: string;
  /**
   * Fan-out seam. Injected rather than imported so the service has no opinion
   * about how delivery happens — swapping the in-memory registry for a
   * Redis-backed one when the API scales horizontally touches the wiring, not
   * this file.
   */
  connections: Pick<ConnectionRegistry, 'send'>;
}

/** An already-validated attachment, handed over by the routes layer. */
export interface MessageAttachment {
  buffer: Buffer;
  /** Magic-byte-detected MIME type, already cross-checked against the header. */
  mimeType: string;
  sizeBytes: number;
  /** File extension (no dot), derived from magic-byte detection. */
  ext: string;
  type: MessageAttachmentType;
}

export interface SendMessageParams {
  senderId: string;
  conversationId: string;
  text?: string;
  attachment?: MessageAttachment;
}

/** The Conversation columns every read in this module touches. */
interface ConversationRow {
  id: string;
  subscriberId: string;
  modelId: string;
  lastMessageAt: Date | null;
  createdAt: Date;
}

/** The Message columns every read in this module touches. */
interface MessageRow {
  id: string;
  conversationId: string;
  senderId: string;
  body: string | null;
  attachmentType: string | null;
  attachmentMimeType: string | null;
  attachmentSizeBytes: number | null;
  readAt: Date | null;
  createdAt: Date;
}

function toConversationSummary(row: ConversationRow): ConversationSummary {
  return {
    conversationId: row.id,
    subscriberId: row.subscriberId,
    modelId: row.modelId,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Project a Message row onto the wire shape. This is the ONLY place a message
 * becomes client-visible JSON, which is what makes "the storage key is never
 * serialized" a property of the module rather than a habit — the field is not
 * in the output type, so no caller can leak it by forgetting to strip it.
 */
function toMessageItem(row: MessageRow): MessageItem {
  return {
    messageId: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    body: row.body,
    attachmentType: (row.attachmentType as MessageAttachmentType | null) ?? null,
    attachmentMimeType: row.attachmentMimeType,
    attachmentSizeBytes: row.attachmentSizeBytes,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * What the conversation list shows for the newest message. An attachment-only
 * message has no text to preview, so it is labelled by kind — and a long body
 * is truncated here rather than shipped whole, because an inbox listing has no
 * business carrying every conversation's full last message.
 */
function previewOf(row: Pick<MessageRow, 'body' | 'attachmentType'> | undefined): string | null {
  if (!row) return null;
  if (row.body !== null && row.body !== '') {
    return row.body.length > MESSAGE_PREVIEW_MAX_LENGTH
      ? `${row.body.slice(0, MESSAGE_PREVIEW_MAX_LENGTH)}…`
      : row.body;
  }
  if (row.attachmentType === 'IMAGE') return '[image]';
  if (row.attachmentType === 'VIDEO') return '[video]';
  return null;
}

export function createMessagingService({
  prisma,
  storage,
  bucket,
  connections,
}: MessagingServiceDeps) {
  /**
   * Load a conversation the caller actually participates in. A conversation
   * that does not exist and one the caller has no part in are the same 404 —
   * see invariant 2 at the top of the file.
   */
  async function loadParticipating(
    userId: string,
    conversationId: string,
  ): Promise<ConversationRow> {
    const conversation = (await prisma.conversation.findUnique({
      where: { id: conversationId },
    })) as ConversationRow | null;
    if (!conversation) {
      throw new MessagingError(404, 'conversation_not_found');
    }
    if (conversation.subscriberId !== userId && conversation.modelId !== userId) {
      throw new MessagingError(404, 'conversation_not_found');
    }
    return conversation;
  }

  /** The participant who is not `userId`. */
  function otherParticipant(conversation: ConversationRow, userId: string): string {
    return conversation.subscriberId === userId ? conversation.modelId : conversation.subscriberId;
  }

  return {
    /**
     * Create (or return) the conversation between a subscriber and a model.
     * Idempotent: the pair is UNIQUE in the database, so a second call answers
     * 200 with the same row instead of racing to insert a duplicate.
     */
    async createConversation(
      subscriberId: string,
      modelId: string,
    ): Promise<{ conversation: ConversationSummary; created: boolean }> {
      const model = await prisma.user.findUnique({ where: { id: modelId } });
      if (!model || model.role !== 'MODEL') {
        throw new MessagingError(404, 'model_not_found');
      }
      const profile = await prisma.modelProfile.findUnique({ where: { userId: modelId } });
      if (!profile) {
        throw new MessagingError(404, 'model_not_found');
      }

      const existing = (await prisma.conversation.findUnique({
        where: { subscriberId_modelId: { subscriberId, modelId } },
      })) as ConversationRow | null;
      if (existing) {
        return { conversation: toConversationSummary(existing), created: false };
      }

      // Starting a conversation requires an ACTIVE subscription. Note this gate
      // is checked before the insert but is NOT what authorizes later sends —
      // those re-read the same field live, so a lapse takes effect immediately.
      const subscription = await prisma.subscription.findUnique({
        where: { subscriberId_modelId: { subscriberId, modelId } },
      });
      if (!subscription || subscription.status !== 'ACTIVE') {
        throw new MessagingError(403, 'subscription_required');
      }

      const created = (await prisma.conversation.create({
        data: { subscriberId, modelId },
      })) as ConversationRow;
      return { conversation: toConversationSummary(created), created: true };
    },

    /**
     * The caller's conversations, newest activity first.
     *
     * Three queries, whatever the number of conversations — no N+1:
     *   1. the conversations themselves, with both participants' display names
     *      joined in (so naming the other party costs no extra round trip);
     *   2. ONE `groupBy` for every unread count at once;
     *   3. ONE `distinct`-on-conversation read for every last message at once
     *      (Postgres DISTINCT ON, served by the `(conversationId, createdAt)`
     *      index).
     * Merging them is in-memory work over at most one row per conversation.
     */
    async listConversations(userId: string): Promise<ConversationListResponse> {
      const conversations = await prisma.conversation.findMany({
        where: { OR: [{ subscriberId: userId }, { modelId: userId }] },
        // NULLS LAST: a conversation nobody has written in yet sorts below every
        // conversation that has activity, rather than to the top.
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        include: {
          subscriber: { select: { id: true, displayName: true } },
          model: { select: { id: true, displayName: true } },
        },
      });

      if (conversations.length === 0) {
        return { conversations: [] };
      }
      const ids = conversations.map((row) => row.id);

      const [unreadGroups, lastMessages] = await Promise.all([
        prisma.message.groupBy({
          by: ['conversationId'],
          where: {
            conversationId: { in: ids },
            readAt: null,
            // Only the other party's messages count as unread: your own are
            // read by definition.
            senderId: { not: userId },
          },
          _count: { _all: true },
        }),
        prisma.message.findMany({
          where: { conversationId: { in: ids } },
          distinct: ['conversationId'],
          // DISTINCT ON requires the distinct column to lead the ordering; the
          // `createdAt DESC` that follows is what picks the *newest* per row.
          orderBy: [{ conversationId: 'asc' }, { createdAt: 'desc' }],
          select: { conversationId: true, body: true, attachmentType: true },
        }),
      ]);

      const unreadByConversation = new Map<string, number>(
        unreadGroups.map((group) => [group.conversationId, group._count._all]),
      );
      const lastByConversation = new Map(
        lastMessages.map((row) => [row.conversationId, row]),
      );

      const items: ConversationListItem[] = conversations.map((row) => {
        const other = row.subscriberId === userId ? row.model : row.subscriber;
        return {
          conversationId: row.id,
          otherParticipantId: other.id,
          otherParticipantDisplayName: other.displayName,
          lastMessagePreview: previewOf(lastByConversation.get(row.id)),
          lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
          unreadCount: unreadByConversation.get(row.id) ?? 0,
        };
      });

      return { conversations: items };
    },

    /**
     * One page of history, newest first, for a participant only.
     *
     * Cursor-based: `before` is a message id, and Prisma turns
     * `cursor` + `skip: 1` over `(createdAt DESC, id DESC)` into a keyset
     * comparison — the `id` tiebreaker matters because two messages can share a
     * millisecond. A cursor from another conversation simply matches nothing:
     * the `where` is scoped to this conversation, so it cannot page across.
     */
    async listMessages(
      userId: string,
      conversationId: string,
      query: { before?: string; limit: number },
    ): Promise<MessageHistoryResponse> {
      await loadParticipating(userId, conversationId);

      const rows = (await prisma.message.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
      })) as MessageRow[];

      return {
        messages: rows.map(toMessageItem),
        // A full page means there may be more; a short page is the end.
        nextCursor: rows.length === query.limit ? rows[rows.length - 1].id : null,
      };
    },

    /**
     * Persist one message and push it to the other participant.
     *
     * The write and the `lastMessageAt` bump commit together: a conversation
     * that lists a message it does not contain (or contains one it does not
     * list) is a state no reader should ever be able to observe.
     *
     * Broadcast happens *after* the commit and never throws into the caller.
     * Delivery is best-effort — a recipient with no open socket reads the
     * message from history — so a fan-out failure must not fail a send that
     * already succeeded.
     */
    async sendMessage(params: SendMessageParams): Promise<MessageItem> {
      const { senderId, conversationId, text, attachment } = params;
      const conversation = await loadParticipating(senderId, conversationId);

      if (text === undefined && !attachment) {
        throw new MessagingError(400, 'empty_message');
      }

      // Live subscription gate — subscriber side only. Re-read on every send
      // rather than trusted from conversation-creation time (invariant 3).
      if (senderId === conversation.subscriberId) {
        const subscription = await prisma.subscription.findUnique({
          where: {
            subscriberId_modelId: { subscriberId: senderId, modelId: conversation.modelId },
          },
        });
        if (!subscription || subscription.status !== 'ACTIVE') {
          throw new MessagingError(403, 'subscription_inactive');
        }
      }

      let storageKey: string | null = null;
      if (attachment) {
        storageKey = `messages/${conversationId}/${createId()}.${attachment.ext}`;
        await storage.uploadFile(bucket, storageKey, attachment.buffer, attachment.mimeType);
      }

      const now = new Date();
      const message = (await prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            conversationId,
            senderId,
            body: text ?? null,
            attachmentType: attachment?.type ?? null,
            attachmentStorageKey: storageKey,
            attachmentMimeType: attachment?.mimeType ?? null,
            attachmentSizeBytes: attachment?.sizeBytes ?? null,
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: now },
        });
        return created;
      })) as MessageRow;

      const item = toMessageItem(message);
      connections.send(otherParticipant(conversation, senderId), {
        type: MESSAGE_EVENT_NEW,
        message: item,
      });
      return item;
    },

    /**
     * Mint a short-lived signed URL for a message's attachment. The key itself
     * is read here and goes no further — the caller receives a URL that stops
     * working in a minute, not a durable handle on the object.
     */
    async getAttachmentUrl(
      userId: string,
      messageId: string,
    ): Promise<MessageAttachmentUrlResponse> {
      const message = (await prisma.message.findUnique({ where: { id: messageId } })) as
        | (MessageRow & { attachmentStorageKey: string | null })
        | null;
      // A message that does not exist, one in someone else's conversation, and
      // one with no attachment are all the same 404 — none of them should tell
      // the caller which of the three it was.
      if (!message) {
        throw new MessagingError(404, 'attachment_not_found');
      }
      try {
        await loadParticipating(userId, message.conversationId);
      } catch {
        throw new MessagingError(404, 'attachment_not_found');
      }
      if (!message.attachmentStorageKey) {
        throw new MessagingError(404, 'attachment_not_found');
      }

      const signedUrl = await storage.getSignedUrl(
        bucket,
        message.attachmentStorageKey,
        ATTACHMENT_URL_TTL,
      );
      return { signedUrl, expiresIn: ATTACHMENT_URL_TTL };
    },

    /**
     * Mark the other participant's unread messages as read. Idempotent by its
     * own `where`: it names `readAt: null`, so a second call matches zero rows
     * and reports 0 rather than re-stamping timestamps.
     */
    async markRead(
      userId: string,
      conversationId: string,
    ): Promise<MarkConversationReadResponse> {
      await loadParticipating(userId, conversationId);
      const { count } = await prisma.message.updateMany({
        where: { conversationId, senderId: { not: userId }, readAt: null },
        data: { readAt: new Date() },
      });
      return { conversationId, markedRead: count };
    },
  };
}

export type MessagingService = ReturnType<typeof createMessagingService>;
