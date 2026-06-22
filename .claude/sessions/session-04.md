# Session 04 — Content Management

## Context Recap (from CLAUDE.md)

- **Stack:** Fastify 5 + Prisma + PostgreSQL (Supabase) + pnpm workspaces + Turborepo; tests via Vitest (38 passing).
- **Auth:** JWT in httpOnly cookies (access 15m / refresh 7d); `authenticate` + `authorize(...roles)` RBAC preHandler hooks in `src/middleware/auth.ts`; roles: `admin`, `model`, `subscriber`.
- **Storage:** `apps/api/src/lib/storage.ts` — S3-compatible `StorageClient` (`uploadFile` / `getSignedUrl` / `deleteFile`) backed by Supabase Storage; env vars `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_REGION`.
- **Onboarding (Session 03):** `ModelProfile` (1:1 with `MODEL` User) + `ReferenceImage` models live in Prisma; multipart upload pipeline with magic-byte validation and `@fastify/multipart` registered globally.
- **Session 04 scope:** Build the content upload, storage, serving, watermarking, and tier-based access pipeline. This is the core value-delivery mechanism — models upload content; subscribers access it based on their subscription tier.

---

## Objective

Implement the complete content lifecycle for the platform:

1. Models upload content (images/videos) with metadata — these are stored securely and never exposed directly.
2. Content is served exclusively via short-lived signed URLs (never public, never permanent).
3. Images are watermarked server-side before delivery.
4. Subscribers access content based on their active tier (`FREE`, `STANDARD`, `PREMIUM`) or individual PPV unlock (scaffold for Session 05).
5. All access is logged for audit purposes.

---

## Prisma Schema Changes

Add the following models to `apps/api/prisma/schema.prisma`. Migrate and apply to Supabase.

```prisma
enum ContentType {
  IMAGE
  VIDEO
}

enum ContentTier {
  FREE        // visible to anyone (preview/teaser)
  STANDARD    // requires active subscription (any tier)
  PREMIUM     // requires PREMIUM subscription tier or PPV unlock
}

model Content {
  id           String      @id @default(cuid())
  modelId      String
  model        User        @relation(fields: [modelId], references: [id])
  title        String
  description  String?
  type         ContentType
  tier         ContentTier @default(STANDARD)
  storageKey   String      // S3 key, never exposed externally
  mimeType     String
  sizeBytes    Int
  width        Int?        // pixels, images only
  height       Int?        // pixels, images only
  durationSecs Int?        // seconds, videos only
  isPublished  Boolean     @default(false)
  ppvPriceCents Int?       // null = not PPV; set = optional PPV add-on (Session 05 uses this)
  viewCount    Int         @default(0)
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  accesses     ContentAccess[]

  @@index([modelId])
  @@index([tier])
  @@index([isPublished])
}

model ContentAccess {
  id          String   @id @default(cuid())
  contentId   String
  content     Content  @relation(fields: [contentId], references: [id])
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  grantReason String   // 'subscription_standard' | 'subscription_premium' | 'ppv_purchase' | 'model_owner' | 'admin'
  grantedAt   DateTime @default(now())
  expiresAt   DateTime? // null = permanent (e.g. PPV purchase); set for subscription-based (recalculated on renewal)

  @@unique([contentId, userId])
  @@index([userId])
  @@index([contentId])
}
```

Also add relations back on `User`:
```prisma
// inside model User { ... }
uploadedContent  Content[]
contentAccesses  ContentAccess[]
```

**Migration name:** `add_content_management`

> ⚠️ After `prisma migrate dev --name add_content_management`, run `prisma generate` and verify the generated client compiles cleanly.

---

## Deliverables & Acceptance Criteria

### 1. Content Upload — `POST /api/content/upload`

- **Auth:** `authenticate` + `authorize('model')`.
- **Body:** multipart/form-data — fields: `title` (string, required, max 200 chars), `description` (string, optional, max 2000 chars), `type` (`IMAGE` | `VIDEO`), `tier` (`FREE` | `STANDARD` | `PREMIUM`, default `STANDARD`), `ppvPriceCents` (integer ≥ 100, optional). File: single file field named `file`.
- **File validation (BEFORE writing to storage):**
  - Accepted MIME types: `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/quicktime`.
  - Magic-byte validation using `file-type` (already installed) — Content-Type header must match detected magic bytes. Reject with 400 if mismatch.
  - Max size: **50 MB** for images, **500 MB** for videos. Reject with 413 if exceeded.
  - Reject if model's `isVerified` is false (403) or model has no `ModelProfile` (403).
- **Storage key format:** `content/{modelId}/{cuid()}.{ext}` (use `cuid` from `@paralleldrive/cuid2` or generate with `crypto.randomUUID()` to keep deps minimal).
- **Image dimensions:** for images, detect width/height using `sharp` (already a common Node dep — add it). Store in `Content.width` / `Content.height`.
- **Video duration:** for videos, skip at MVP — `durationSecs` remains `null` (requires `ffprobe`; out of scope).
- **Response:** `201 { contentId, title, tier, type, isPublished: false }`.
- **Rate limit:** 20 uploads/model/hour.
- **Acceptance criteria:**
  - Uploading a valid JPEG returns 201 with `contentId`.
  - Uploading a PNG renamed as `.jpg` (magic-byte mismatch) returns 400.
  - Uploading a file > 50 MB (image) returns 413.
  - Subscriber calling this endpoint returns 403.
  - Content row is created in DB with `isPublished: false`.

---

### 2. Publish / Unpublish — `PATCH /api/content/:contentId/publish`

- **Auth:** `authenticate` + `authorize('model')`.
- **Body:** `{ publish: boolean }`.
- **Logic:** Verify `content.modelId === request.user.userId` (403 otherwise). Toggle `isPublished`.
- **Response:** `200 { contentId, isPublished }`.
- **Acceptance criteria:**
  - Model can publish own content → `isPublished: true`.
  - Model cannot publish another model's content → 403.

---

### 3. List Model Content — `GET /api/content/model/:modelId`

- **Auth:** Optional (public endpoint for browsing, but results are filtered).
- **Access rules:**
  - `FREE` content: always returned (published only).
  - `STANDARD` content: returned only if requester has an active `ContentAccess` for this model's standard-or-higher tier, OR is the model owner, OR is admin.
  - `PREMIUM` content: returned only if requester has `ContentAccess` with `grantReason` of `subscription_premium` or `ppv_purchase`, OR is model owner, OR is admin.
  - **Never return `storageKey`** in any response — only derived signed URLs.
- **Query params:** `page` (default 1), `limit` (default 20, max 50), `type` (`IMAGE` | `VIDEO`, optional filter), `tier` (optional filter).
- **Response shape per item:**
  ```json
  {
    "contentId": "...",
    "title": "...",
    "type": "IMAGE",
    "tier": "STANDARD",
    "isPublished": true,
    "thumbnailUrl": "https://...",   // signed URL, 5-min TTL, null if no access
    "hasAccess": true,
    "ppvPriceCents": null,
    "viewCount": 42,
    "createdAt": "..."
  }
  ```
- **Acceptance criteria:**
  - Unauthenticated request returns only FREE published content.
  - `thumbnailUrl` is `null` for content the requester cannot access.
  - `storageKey` never appears in any response field.

---

### 4. Serve Content (Watermarked) — `GET /api/content/:contentId/serve`

This is the critical content delivery endpoint.

- **Auth:** `authenticate` (required — no anonymous content delivery).
- **Access check:** Verify the user has a valid, non-expired `ContentAccess` row for this `contentId`, OR is the model owner, OR is admin. Return 403 if not.
- **Image watermarking (server-side, images only):**
  - Fetch the raw image bytes from storage (via `StorageClient.getObject` — add this method if missing, or download the file via `getSignedUrl` + `fetch`).
  - Use `sharp` to composite a semi-transparent text watermark onto the image:
    - Text: platform name + user's email (e.g., `"CreatorPlatform • user@example.com"`)
    - Position: bottom-right, with padding.
    - Opacity: 40% (semi-transparent, visible but not obstructing).
    - Font: white text with a dark drop shadow using SVG overlay (Sharp supports SVG composite).
  - Stream the watermarked image bytes directly in the HTTP response. Do NOT store the watermarked version — watermark on the fly every time.
  - `Content-Type`: match the original `mimeType`.
  - `Content-Disposition: inline`.
  - Cache headers: `Cache-Control: no-store` (watermarked content must never be cached; cache invalidation is complex and the watermark is per-user).
- **Videos:** For MVP, return a signed URL (60-second TTL) for the raw video file. No server-side watermark for video at this stage (requires `ffmpeg`; out of scope). Document this limitation in CLAUDE.md Open Items.
- **Increment `viewCount`:** After successful access grant, increment `content.viewCount` (non-blocking — use `prisma.$executeRaw` or a fire-and-forget update; do not delay the response).
- **Response:**
  - Images: raw watermarked bytes (streamed).
  - Videos: `200 { signedUrl: "...", expiresIn: 60 }`.
- **Acceptance criteria:**
  - Authenticated subscriber with `ContentAccess` receives watermarked image bytes.
  - Subscriber without access receives 403.
  - Unauthenticated request receives 401.
  - `storageKey` never appears in any response.
  - Response headers include `Cache-Control: no-store` for images.

---

### 5. Grant Access (Internal Service Function)

> This is NOT a public API endpoint. It is a service function used internally now (for model owners and admin) and by Session 05 (Stripe webhooks for subscription/PPV grants).

Create `apps/api/src/modules/content/content.service.ts` with:

```typescript
export async function grantContentAccess(params: {
  contentId: string;
  userId: string;
  grantReason: string;
  expiresAt?: Date | null;
}): Promise<ContentAccess>
```

- Upserts a `ContentAccess` row (update on conflict for `contentId+userId` unique constraint — refresh `expiresAt` and `grantReason`).
- Used by the serve endpoint to auto-grant model owners access to their own content.
- Will be called by Session 05's Stripe webhook handler.

Also create:

```typescript
export async function revokeContentAccess(contentId: string, userId: string): Promise<void>
```

---

### 6. Delete Content — `DELETE /api/content/:contentId`

- **Auth:** `authenticate` + `authorize('model', 'admin')`.
- **Logic:** Model can only delete own content (403 if `content.modelId !== userId`). Admin can delete any. Soft-delete: set `isPublished: false` + add a `deletedAt DateTime?` field to `Content` (add to schema). Do NOT delete from storage immediately — schedule via a future cleanup job (out of scope; just mark `deletedAt`).
- **Response:** `204 No Content`.

---

### 7. StorageClient Enhancement

Add to `apps/api/src/lib/storage.ts`:

```typescript
getObject(key: string): Promise<Buffer>
```

Used by the serve endpoint to fetch raw image bytes for watermarking.

---

## Security Requirements

- **`storageKey` MUST NEVER appear in any API response** — not in body, not in headers, not in error messages. This is the single most important security rule of this session.
- All upload endpoints must re-validate the file after reading it (magic-byte check). Do not trust Content-Type header alone.
- Signed URLs for storage access must have a **maximum TTL of 300 seconds (5 minutes)** for thumbnails. The serve endpoint uses direct byte streaming, not signed URLs.
- Watermarked images must include `Cache-Control: no-store` — the per-user watermark means caching is unsafe.
- The `ContentAccess.expiresAt` must be checked server-side on every request to `/serve`. A row with a past `expiresAt` is treated as no access.
- Rate limit upload endpoint: 20 uploads/model/hour.
- Input validation: all fields validated with Zod. `title` max 200 chars; `description` max 2000 chars; `ppvPriceCents` if present must be integer ≥ 100.
- RBAC enforced on all endpoints. Never trust client-supplied `modelId` — always derive from JWT.

---

## Performance Requirements

- Signed URL generation for thumbnails in the list endpoint: batch if possible (or generate in parallel with `Promise.all`, not sequentially).
- `viewCount` increment is fire-and-forget — must not block the serve response.
- Sharp watermarking should complete in < 500ms for typical images (< 5 MB). Use `sharp().resize({ width: 2048, withoutEnlargement: true })` to cap processing size before watermarking if image is very large.
- Upload endpoint uses streaming multipart (`@fastify/multipart` already registered) — do not buffer entire file into memory before starting storage upload. If StorageClient currently buffers to Buffer before upload, that is acceptable at MVP but document it as a known limitation (streaming upload to S3 requires multipart S3 upload API — out of scope).

---

## Tech Choices Guidance

- **`sharp`** — industry standard for server-side image processing in Node.js. Already the obvious choice; install in `apps/api`. Justify briefly in code comments.
- **`@paralleldrive/cuid2`** — for collision-resistant content IDs in storage keys (or use `crypto.randomUUID()` if you want zero new deps).
- **`file-type`** — already used in Session 03 for magic-byte detection. Use the same pattern.
- If StorageClient's `getObject` needs to be added: use `@aws-sdk/client-s3`'s `GetObjectCommand` and convert the readable stream to a Buffer. The S3 SDK is already installed.
- Do NOT add `ffmpeg` or `ffprobe` — video duration/watermarking is explicitly out of scope for this session.

---

## Module Structure

Create `apps/api/src/modules/content/`:

```
apps/api/src/modules/content/
├── content.routes.ts    # HTTP layer: multipart, rate limits, response shaping
├── content.service.ts   # Business logic: upload, access control, grantAccess, revokeAccess
├── content.schema.ts    # Zod schemas
└── content.test.ts      # Integration tests
```

Register the content plugin in `apps/api/src/index.ts` under prefix `/api/content`.

---

## Tests (Vitest)

Add `apps/api/src/modules/content/content.test.ts`. All tests must use in-memory mocks for Prisma and StorageClient (same pattern as Session 02/03). Minimum test cases:

```
Upload:
  ✓ model uploads valid JPEG → 201 with contentId
  ✓ model uploads file with mismatched Content-Type → 400
  ✓ subscriber uploads → 403
  ✓ unauthenticated upload → 401
  ✓ file exceeds 50 MB image limit → 413

Publish:
  ✓ model publishes own content → 200 isPublished: true
  ✓ model publishes another model's content → 403

List:
  ✓ unauthenticated → only FREE published content returned
  ✓ authenticated subscriber with access → STANDARD content included
  ✓ storageKey never present in response

Serve:
  ✓ subscriber with ContentAccess → receives watermarked bytes (mock sharp)
  ✓ subscriber without ContentAccess → 403
  ✓ unauthenticated → 401
  ✓ Cache-Control: no-store present in image response

Delete:
  ✓ model deletes own content → 204 + deletedAt set
  ✓ model deletes another model's content → 403
```

Total target: **≥ 15 new tests**. Running `pnpm turbo run test` must show all prior tests still passing (no regressions).

---

## Definition of Done

- [ ] Prisma schema updated with `Content`, `ContentAccess`, `deletedAt` field; migration applied and client generated
- [ ] `StorageClient.getObject(key)` method implemented
- [ ] `POST /api/content/upload` — multipart, magic-byte validation, sharp dimensions, 201 response, rate-limited
- [ ] `PATCH /api/content/:contentId/publish` — ownership check, toggle, 200
- [ ] `GET /api/content/model/:modelId` — tier-filtered list, signed thumbnail URLs, no storageKey in response
- [ ] `GET /api/content/:contentId/serve` — access check, sharp watermarking for images, signed URL for video, viewCount increment, Cache-Control: no-store
- [ ] `DELETE /api/content/:contentId` — soft delete (deletedAt), ownership enforced
- [ ] `grantContentAccess` + `revokeContentAccess` service functions implemented
- [ ] `storageKey` confirmed absent from all API responses (grep test or comment confirming this)
- [ ] ≥ 15 new tests written and passing
- [ ] `pnpm turbo run typecheck lint test` — all green, zero regressions
- [ ] No hardcoded secrets or storage keys in any source file
- [ ] All session security requirements met
- [ ] ARIA validation passed (return results to ARIA before proceeding)
