# Session 07 — Real-Time Private Messaging

## Context Recap (from CLAUDE.md)

- Stack is Fastify 5 + Prisma/PostgreSQL (Supabase), JWT (access 15m / refresh 7d) in httpOnly cookies, RBAC via `authenticate` + `authorize(...roles)` preHandler hooks. 197 tests green through Session 06.5, zero regressions expected.
- Session 06.5 shipped an honest `Subscription.status` (`ACTIVE | PAST_DUE | EXPIRED | CANCELED`) plus `cancelAtPeriodEnd`. This session reads that field as the access gate — it does not reinterpret or duplicate subscription logic.
- Session 04 already solved "validate and store user-uploaded media safely": `StorageClient` (S3-compatible, Supabase Storage), magic-byte + declared-Content-Type cross-check via `file-type`, per-type size caps, storage keys that never leave the service, delivery only via short-TTL signed URLs. This session reuses that pattern verbatim for message attachments — no parallel implementation.
- Module boundary discipline holds: one Prisma-model-owning module per domain (`auth`, `onboarding`, `content`, `payments`, `payouts`, `subscriptions`). This session's code lives in a new `modules/messaging/`.
- Out of scope, confirmed with the user: no live video/voice calling, no group chats. This is 1:1 real-time text + media messaging between one subscriber and one model.

## Product Decisions (confirmed by the user — do not re-litigate these)

1. **Real-time, not polling.** Messages are delivered over a WebSocket connection, not client-side polling.
2. **Attachments:** a message may include text, one image, one video, or both text and one attachment. No video/voice calls.
3. **Who can start a conversation:** only a subscriber with an **`ACTIVE`** `Subscription` to that model may create a new conversation with them.
4. **Assumption stated for confirmation before/at Claude Code run (flag to the user if this needs to change):** once a conversation exists, the **subscriber** can only send new messages while their subscription is `ACTIVE` (a `PAST_DUE`/`EXPIRED`/`CANCELED` subscriber sees history but gets `403 subscription_inactive` on send). The **model** can always reply within any conversation they are a participant of — a model is never blocked from answering a paying customer's last message just because that customer's subscription lapsed mid-conversation. Existing message history remains visible to both parties regardless of subscription state (paid-for messages are never retroactively hidden).

## Objective

Ship 1:1 real-time private messaging between a subscriber and a model: conversation creation gated by an active subscription, text + single-image/video attachments reusing the Session 04 upload pipeline, real-time delivery over WebSocket, and a REST history/read-receipt API — all behind the existing RBAC and idempotency/security conventions of the codebase.

## Deliverables & Acceptance Criteria

### Data model

- `Conversation` (Prisma): `id`, `subscriberId` → `User`, `modelId` → `User`, `lastMessageAt DateTime?`, `createdAt`. `@@unique([subscriberId, modelId])` — one conversation per pair, mirroring `Subscription`'s own unique pair constraint. Indexes on `(modelId, lastMessageAt)` and `(subscriberId, lastMessageAt)` for the conversation-list query.
- `Message` (Prisma): `id`, `conversationId` → `Conversation`, `senderId` → `User`, `body String?` (nullable when the message is attachment-only), `attachmentType` (`IMAGE | VIDEO`, nullable), `attachmentStorageKey String?` (never serialized to a client, same rule as `Content.storageKey`), `attachmentMimeType String?`, `attachmentSizeBytes Int?`, `readAt DateTime?`, `createdAt`. Index on `(conversationId, createdAt)` for cursor pagination. A `CHECK` (raw SQL in the migration, Prisma has no primitive) requiring `body IS NOT NULL OR attachmentType IS NOT NULL` — a message can't be completely empty.
- Migration generated **and applied** to Supabase before this session is marked done; `prisma migrate status` shows it live.

### REST endpoints

- `POST /api/messages/conversations/:modelId` — `authenticate` + `authorize('subscriber')`. Creates the conversation if it doesn't exist (idempotent: a second call for the same pair returns the existing row, 200, not a duplicate). **403 `subscription_required`** if the caller has no `ACTIVE` `Subscription` row for `(callerId, modelId)`. 404 if `modelId` doesn't resolve to a `MODEL` with a profile. Integration test: subscriber with `ACTIVE` subscription → 201 first call, 200 second call, same `conversationId`; subscriber with `PAST_DUE` subscription → 403.
- `GET /api/messages/conversations` — `authenticate` (either role). Returns the caller's conversations ordered by `lastMessageAt DESC NULLS LAST`, each with the other participant's `displayName`, a preview of the last message (`body` truncated, or `"[image]"`/`"[video]"` if the last message was attachment-only), and an `unreadCount`. Unread count must come from one aggregated query (e.g., `groupBy` on `Message` filtered by `readAt: null` and `senderId != callerId`), not an N+1 per conversation. Integration test asserts a single query plan / call count, not just correct output.
- `GET /api/messages/conversations/:conversationId/messages` — `authenticate`, participant-only. **404 (not 403) for a conversation the caller isn't part of** — mirrors the Session 06 payout-detail pattern so conversation ids aren't enumerable. Cursor-paginated: `?before=<messageId>&limit=50` (default 50, max 100), ordered `createdAt DESC`, indexed on `(conversationId, createdAt)`. Attachment fields in the response never include `attachmentStorageKey` — only `attachmentType`/`attachmentMimeType`/`attachmentSizeBytes` plus a `messageId` a client uses to fetch a signed URL separately.
- `POST /api/messages/conversations/:conversationId/messages` — `authenticate`, participant-only (404 for non-participants, same as above). Body: `{ text?: string }` via JSON, **or** multipart when an attachment is included (reuse `@fastify/multipart`, already registered globally). At least one of `text`/attachment required (400 `empty_message` otherwise). If the sender is the subscriber, re-check `Subscription.status === 'ACTIVE'` for the pair at send time (**403 `subscription_inactive`** otherwise) — this is a live check, not cached from conversation-creation time. If the sender is the model, no subscription check. On success: persists the `Message`, bumps `Conversation.lastMessageAt`, and broadcasts a `message.new` event (see WebSocket section) to the other participant if they are connected. 201 with the created message (no `attachmentStorageKey`). Attachment validation identical in spirit to Session 04's content upload: magic-byte + declared-Content-Type cross-check via `file-type`, reject on mismatch (415), size caps **15 MB for images / 100 MB for videos** (smaller than Session 04's catalog caps — chat attachments are not the monetized content library), storage key `messages/{conversationId}/{cuid2}.{ext}`. Rate-limited **60 messages/min per user** (keyed on `userId`, not IP, matching the payments-checkout precedent).
- `GET /api/messages/attachments/:messageId` — `authenticate`, participant-only (404 for non-participants). Mints a 60-second signed URL for the attachment (same TTL as Session 04's video serving) via `StorageClient.getSignedUrl`; never returns the storage key itself.
- `PATCH /api/messages/conversations/:conversationId/read` — `authenticate`, participant-only. Sets `readAt = now()` on every unread message in that conversation sent by the *other* participant. 200, idempotent (a second call is a no-op).

### WebSocket (real-time delivery)

- One WebSocket route (e.g. `GET /ws/messages`). Authentication happens **during the upgrade**, using the existing access-token httpOnly cookie — reuse the `authenticate` hook's verification logic (adapted for the upgrade request), never a token in a query string or the WS URL (query strings end up in server access logs). Reject unauthenticated upgrades with `401` before completing the handshake.
- On connect, the server associates the socket with the authenticated `userId` in memory (a `Map<userId, Set<WebSocket>>` or equivalent is sufficient for a single-instance MVP deployment — see Tech Choices Guidance on scaling).
- **The WebSocket is broadcast-only — it is not a second message-creation path.** All message writes go through `POST /api/messages/conversations/:conversationId/messages`; the only thing the socket does is push a `message.new` event (the serialized message, minus `attachmentStorageKey`) to the other participant if and only if they hold an open connection. This mirrors the project's existing "one call site" discipline (e.g. `issueSubscriptionCharge` in Session 06.5) — one write path is easy to audit and rate-limit, fan-out is a pure read-side concern.
- Integration test: two authenticated clients (subscriber + model) connect, one POSTs a message via REST, the other's socket receives the `message.new` event with the correct payload and no `attachmentStorageKey`.

### Shared types (`@creator-platform/shared`)

`ConversationListItem`, `ConversationSummary`, `MessageItem`, `SendMessageRequest`/`SendMessageResponse`, `MESSAGE_ATTACHMENT_TYPES`, and the `message.new` WebSocket event payload type.

## Security Requirements

- WebSocket upgrade authenticated via the existing httpOnly access-token cookie only — no token accepted via query string, header the client controls freely, or any channel that could leak into logs.
- Every conversation/message read or write is participant-scoped; a non-participant gets **404**, never 403, so conversation ids are not enumerable (same reasoning as Session 06's payout-detail endpoint).
- Sending is gated by a **live** `Subscription.status === 'ACTIVE'` check for subscriber-originated messages — not a check performed once at conversation creation and trusted thereafter.
- Attachments: magic-byte + declared-Content-Type cross-check (`file-type`, already a dependency), reject on mismatch, enforce the 15 MB / 100 MB caps server-side (never trust a client-declared size), only accept an explicit allow-list of image/video MIME types.
- `attachmentStorageKey` never serialized in any API response — delivery exclusively via the 60-second signed URL endpoint, same discipline as `Content.storageKey` and `ReferenceImage.storageKey`.
- Message bodies are never written to server logs in plaintext (this is an adult-content platform; log scrubbing for this field is not optional).
- Rate limiting on message sends (60/min/user) and on WebSocket connection attempts (prevent a single account from opening unbounded concurrent sockets — cap concurrent connections per user, e.g. 3).
- All request/response schemas validated with Zod, including a max length on `body` (e.g. 4000 chars) to prevent oversized-payload abuse.

## Performance Requirements

- Conversation list and message history are single indexed queries — no N+1 across conversations or messages. State this explicitly in the PR/summary with the query plan or call-count assertion from the test.
- Message history pagination is cursor-based (`createdAt` + `id` tiebreaker), never offset-based — required before message volume grows.
- WebSocket fan-out pushes the already-serialized payload to the in-memory connection set for the recipient; it must not issue a database query per connected client per broadcast message.

## Tech Choices Guidance

- Choose and briefly justify a Fastify-native WebSocket plugin (e.g. `@fastify/websocket`) that runs self-hosted on the existing API process — consistent with the project's "avoid expensive proprietary lock-in" principle. A managed pub/sub service (Pusher, Ably) remains optional and is **not** required for this session; CLAUDE.md already lists it as an optional external prerequisite, not a mandatory one.
- Because in-memory fan-out only works correctly on a single running instance, note explicitly (as an Open Item, not something to solve now) that horizontal scaling of the API process would need a shared pub/sub layer (e.g. Redis) to fan out across instances — out of scope for this MVP session, candidate for Session 12/13.
- Reuse `StorageClient`, the `file-type` magic-byte validation pattern, and the `authenticate`/`authorize` hooks exactly as Sessions 03/04 established them.

## Definition of Done

- [ ] All deliverables implemented: `Conversation`/`Message` models + migration applied, conversation create/list, message send/list/read-receipt REST endpoints, WebSocket real-time delivery, attachment upload + signed-URL retrieval
- [ ] Tests written and passing: REST integration tests for every endpoint above (including the 403/404 negative cases) + a WebSocket connect-auth-and-receive test; zero regressions on the existing 197 tests
- [ ] No hardcoded secrets
- [ ] Session security requirements met: live subscription-gated send, participant-only access (404-not-403), signed-URL-only attachment delivery, magic-byte validation, rate limiting, no plaintext message bodies in logs
- [ ] ARIA validation passed
