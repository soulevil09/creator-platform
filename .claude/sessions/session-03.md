# Session 03 — Model Onboarding

## Context Recap (from [CLAUDE.md](http://CLAUDE.md))

* Stack: Next.js 14 + Fastify 5 + Prisma + PostgreSQL (Supabase). Monorepo via pnpm workspaces + Turborepo.

* Auth complete: JWT in httpOnly cookies, RBAC middleware (`authenticate` + `authorize`), roles: ADMIN / MODEL / SUBSCRIBER.

* Storage provider confirmed: **Supabase Storage** — S3-compatible, signed URLs supported.

* Prisma schema has `User` model with `Role` enum. Migration applied to Supabase.

* All env vars live in `apps/api/.env` (never committed). `src/lib/env.ts` crashes at boot if required secrets are missing.

---

## Objective

Build the model onboarding flow: profile data collection, reference image upload to Supabase Storage,\
and AI consent / Terms of Service acceptance. After this session, a newly registered MODEL user can\
complete their profile, upload reference images, and grant (or deny) AI likeness usage consent.

---

## Deliverables & Acceptance Criteria

### 1\. Prisma Schema — `ModelProfile` model

Add to `apps/api/prisma/schema.prisma`:

```prisma
model ModelProfile {
  id              String    @id @default(cuid())
  userId          String    @unique
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  displayName     String
  bio             String?
  country         String    // ISO 3166-1 alpha-2, e.g. "BR"
  currency        String    @default("USD") // "USD" | "BRL" | "EUR"

  aiConsent       Boolean   @default(false)
  aiConsentAt     DateTime?
  tosAcceptedAt   DateTime?

  referenceImages ReferenceImage[]

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
}

model ReferenceImage {
  id             String       @id @default(cuid())
  modelProfileId String
  modelProfile   ModelProfile @relation(fields: [modelProfileId], references: [id], onDelete: Cascade)

  storageKey     String       // Supabase Storage object key (path)
  signedUrl      String?      // ephemeral; not persisted — generated on-demand
  mimeType       String
  sizeBytes      Int

  createdAt      DateTime     @default(now())
}
```

* Generate and apply migration: `prisma migrate dev --name add_model_profile`

* Run `prisma generate` after migration

### 2\. Storage Client — `apps/api/src/lib/storage.ts`

* Implement a `StorageClient` using the `@aws-sdk/client-s3` package (S3-compatible with Supabase Storage)\
  or use `@supabase/storage-js` directly — **justify the choice in a comment at the top of the file**

* Expose the following functions:

  * `uploadFile(bucket, key, buffer, mimeType): Promise<string>` — returns the storage key

  * `getSignedUrl(bucket, key, expiresInSeconds): Promise<string>` — returns a signed URL

  * `deleteFile(bucket, key): Promise<void>`

* Read credentials from env: `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`

* Add these 4 vars to `src/lib/env.ts` startup validation (crash if missing)

* Add them to `apps/api/.env.example` with placeholder values

### 3\. Model Onboarding Module — `apps/api/src/modules/onboarding/`

Files: `onboarding.routes.ts`, `onboarding.service.ts`, `onboarding.schema.ts`, `onboarding.test.ts`

#### 3a. `PUT /api/onboarding/profile`

* **Auth:** `authenticate` + `authorize('MODEL')` — MODEL role only

* **Body (Zod):** `{ displayName: string (min 2, max 60), bio?: string (max 500), country: string (ISO 2-char), currency: 'USD'|'BRL'|'EUR' }`

* Creates or updates `ModelProfile` for the authenticated user (upsert by `userId`)

* If `tosAcceptedAt` is null and body includes `tosAccepted: true` → set `tosAcceptedAt = now()`

* Returns `201` on create, `200` on update: `{ profileId, displayName, country, currency, aiConsent, tosAcceptedAt }`

* Rate limit: 10 req/IP/min

#### 3b. `POST /api/onboarding/consent`

* **Auth:** `authenticate` + `authorize('MODEL')`

* **Body:** `{ aiConsent: boolean }`

* Sets `aiConsent` + `aiConsentAt` (if `true`) on existing `ModelProfile`

* Requires `ModelProfile` to exist (404 if not) and `tosAcceptedAt` to be set (400 if ToS not accepted yet)

* Returns `200`: `{ aiConsent, aiConsentAt }`

* Rate limit: 5 req/IP/min

#### 3c. `POST /api/onboarding/reference-images`

* **Auth:** `authenticate` + `authorize('MODEL')`

* **Request:** `multipart/form-data`, field name `image`, max 1 file per request

* **Validation:**

  * Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`

  * Max file size: **10 MB**

  * Max reference images per model: **10** (return 400 if limit reached)

* On success:

  1. Generate key: `reference-images/{userId}/{cuid()}.{ext}`

  2. Upload to `STORAGE_BUCKET` via `StorageClient.uploadFile`

  3. Persist `ReferenceImage` record (storageKey, mimeType, sizeBytes)

  4. Return `201`: `{ imageId, signedUrl (60s TTL), mimeType, sizeBytes }`

* Rate limit: 20 req/IP/hour

#### 3d. `DELETE /api/onboarding/reference-images/:imageId`

* **Auth:** `authenticate` + `authorize('MODEL')`

* Verify the image belongs to the authenticated user's `ModelProfile` (403 if not)

* Delete from Supabase Storage (`StorageClient.deleteFile`)

* Delete `ReferenceImage` record from DB

* Returns `204` (no body)

#### 3e. `GET /api/onboarding/profile`

* **Auth:** `authenticate` + `authorize('MODEL')`

* Returns full `ModelProfile` for the authenticated user including `referenceImages` array

* For each reference image: generate a fresh signed URL (300s TTL) — **do not persist the URL**

* Returns `200`: `{ profileId, displayName, bio, country, currency, aiConsent, aiConsentAt, tosAcceptedAt, referenceImages: [{ imageId, signedUrl, mimeType, sizeBytes, createdAt }] }`

* Returns `404` if profile not yet created

### 4\. Register routes in `apps/api/src/index.ts`

* Register onboarding routes under prefix `/api/onboarding`

* Register `@fastify/multipart` plugin with global limits: `fileSize: 10 * 1024 * 1024` (10 MB)

### 5\. Shared types update — `packages/shared/src/index.ts`

Add and export:

```typescript
export type OnboardingProfileResponse = {
  profileId: string
  displayName: string
  bio?: string
  country: string
  currency: 'USD' | 'BRL' | 'EUR'
  aiConsent: boolean
  aiConsentAt?: string
  tosAcceptedAt?: string
  referenceImages: ReferenceImageItem[]
}

export type ReferenceImageItem = {
  imageId: string
  signedUrl: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}
```

---

## Security Requirements

* All endpoints require `authenticate` + `authorize('MODEL')` — no unauthenticated access

* File uploads: validate MIME type from buffer magic bytes **and** Content-Type header (reject mismatch)

* Storage keys must never be exposed in API responses — only signed URLs with short TTL

* Signed URLs for reference images: max 300s TTL on `GET /profile`; max 60s on upload confirmation

* Enforce max 10 reference images per model at the service layer (not just client-side)

* No raw DB errors in API responses — map Prisma errors to HTTP codes

* `@fastify/multipart` must be configured with `attachFieldsToBody: false` — stream directly to upload, do not buffer entire multipart body in memory unnecessarily

* Input sanitization: strip leading/trailing whitespace on `displayName` and `bio`; reject if `displayName` is empty after trim

* Country code must be exactly 2 uppercase ASCII letters (Zod: `z.string().length(2).toUpperCase()`)

---

## Performance Requirements

* Reference image upload: stream buffer to Supabase Storage — avoid loading >10 MB in memory if the storage SDK supports streaming (use streaming if available, document the choice)

* Signed URL generation is cheap (local computation for S3-compatible) — no caching needed at MVP

* `GET /api/onboarding/profile` must not make more than 2 DB queries (1 for profile + images, 1 optional)

---

## Tech Choices Guidance

* **Storage SDK:** Prefer `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (S3-compatible with Supabase Storage endpoint) OR `@supabase/storage-js` if it simplifies signed URL generation. Justify in a comment. Both are free open-source.

* **Multipart:** `@fastify/multipart` — already in the Fastify ecosystem, peer of Fastify 5.

* **File type validation:** `file-type` npm package (ESM, reads magic bytes from buffer) — avoids relying solely on Content-Type header.

* **CUID:** `@paralleldrive/cuid2` — already likely present from Prisma defaults; use for storage key generation.

---

## Definition of Done

* \[ \] Prisma migration `add_model_profile` applied and `schema.prisma` updated with `ModelProfile` + `ReferenceImage`

* \[ \] `apps/api/src/lib/storage.ts` implemented with `uploadFile`, `getSignedUrl`, `deleteFile`

* \[ \] `STORAGE_*` env vars added to `env.ts` startup validation and `.env.example`

* \[ \] All 5 onboarding endpoints implemented with correct auth, validation, and rate limits

* \[ \] `@fastify/multipart` registered globally in `src/index.ts`

* \[ \] MIME type validated from magic bytes (not just Content-Type)

* \[ \] Max 10 reference images limit enforced server-side

* \[ \] Signed URLs generated on-demand (never persisted to DB)

* \[ \] Shared types `OnboardingProfileResponse` + `ReferenceImageItem` exported from `@creator-platform/shared`

* \[ \] Tests written in `onboarding.test.ts` covering:

  * \[ \] Create profile (201)

  * \[ \] Update profile (200 idempotent)

  * \[ \] ToS acceptance sets `tosAcceptedAt`

  * \[ \] Consent blocked if ToS not accepted (400)

  * \[ \] Consent granted/revoked (200)

  * \[ \] Upload accepted MIME type → 201 with signedUrl

  * \[ \] Upload rejected MIME type → 400

  * \[ \] Upload over 10 MB → 400

  * \[ \] Upload when limit of 10 reached → 400

  * \[ \] Delete own image → 204

  * \[ \] Delete another model's image → 403

  * \[ \] GET profile with signed URLs → 200

  * \[ \] GET profile not found → 404

  * \[ \] Unauthorized (no token) → 401

  * \[ \] SUBSCRIBER role → 403

* \[ \] `pnpm turbo run typecheck lint test` all green

* \[ \] No hardcoded secrets, no storage keys in API responses, no tokens in response bodies

* \[ \] ARIA validation passed