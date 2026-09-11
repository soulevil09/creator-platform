# Session 09 — Anti-Leak & Content Protection

## Context Recap (from CLAUDE.md)

- Session 04 built signed-URL delivery: images are watermarked **on-the-fly** at serve time (`ImageProcessor.watermark`, sharp-based, never a pre-watermarked copy stored) with `Cache-Control: no-store`; videos are served via a 60s S3 signed URL with **no server-side watermark** (explicitly deferred, flagged "harden in Session 09").
- Session 08 reused the exact same watermark/signed-URL pipeline for AI-generated images (30-day `expiresAt`, on-the-fly watermark, `storageKey` never exposed).
- `storageKey` must never appear in any API response — cardinal rule since Session 04, still true in every module.
- Two Open Items are directly this session's business: **soft-deleted `Content` objects** (Session 04) and **expired `GenerationJob` images** (Session 08) both leave orphaned objects sitting in storage indefinitely after the DB says they're gone.
- `apps/web` currently has no content-viewing page — only `/`, `/wallet`. This session adds a standalone, reusable client-side protection component + a demo route, not a full page (mirrors the narrow-slice precedent of the Session 05 wallet page).

**Out of scope for this session:** Lei FELCA (CPF + Face ID age verification, Lei 15.211/2025) — logged as a separate future session (candidate: Session 9.5) due to its hard 17/03/2026 deadline and distinct KYC vendor integration. Do not touch age-verification flows here.

---

## Objective

Reduce the platform's exposure to leaked/redistributed content through three independent layers of defense-in-depth: **traceability** (forensic watermarking so a leaked file can be traced back to the subscriber who viewed it), **hygiene** (no orphaned unwatermarked originals lingering in storage after logical deletion/expiry), and **friction** (client-side deterrents that raise the cost of casual screen-capture, understood explicitly as a deterrent, not a guarantee).

---

## Deliverables & Acceptance Criteria

### D1 — Forensic (per-viewer) watermarking on images

Extend the existing watermark pipeline so every served image carries a short, opaque, per-request trace code in addition to the existing platform mark — **not** the subscriber's raw email or user ID (that would leak PII into a file that may itself leak).

- `ImageProcessor.watermark` (or a new `watermarkWithTrace` method — implementer's call, justify it) accepts a trace code string and renders it into the existing SVG overlay alongside current branding.
- Trace code = short (8–10 char) base32/hex digest derived from `HMAC-SHA256(WATERMARK_TRACE_SECRET, contentId + viewerId + servedAt-truncated-to-minute)` — deterministic per (content, viewer, minute) so repeated requests in the same minute don't spam distinct codes, but two different viewers of the same content get visibly different codes.
- Every image-serving path is wired to it:
  - `GET /api/content/:contentId/serve`
  - `GET /api/generations/:id/image`
- An `AuditLog` row is written per serve recording `{ contentId or generationJobId, viewerId, traceCode, servedAt }` — this is the lookup table that turns "found this trace code on a leaked screenshot" into "here's who leaked it." Reuse the existing `AuditLog` model; do not create a parallel table unless you can justify why.
- **Acceptance test:** two different authenticated subscribers requesting the same `contentId` receive images whose rendered trace codes differ; the same subscriber requesting twice within the same minute receives the same code; an `AuditLog` row exists for each serve with a queryable `traceCode` that round-trips to the correct `viewerId`.
- **Non-leakage constraint:** the trace code must never be derivable back to a viewer without the `AuditLog` lookup — i.e., no raw `viewerId`/email substring anywhere in the watermark text or the code itself. Add a dedicated test asserting the served image's watermark text contains no substring of the viewer's email or raw UUID.

### D2 — Video protection (choose and justify ONE approach)

Video currently ships with **zero** watermark and a raw signed URL — the single largest gap flagged in Open Items. Pick one path and document the tradeoff in CLAUDE.md's Architecture Decisions:

- **Option A — server-side burn-in:** add `ffmpeg`/`fluent-ffmpeg` (or a lighter alternative you justify), watermark-burn the trace code into the video server-side, either on upload (adds a processing step to `POST /api/content/upload` for videos) or on serve (adds latency/cost per view — evaluate against `GENERATION_TIMEOUT_MS`-style bounding). This closes the gap for good but adds a new heavy native dependency to the low-cost/serverless-friendly stack — justify the cost tradeoff explicitly.
- **Option B — client-side overlay + documented residual risk:** keep the raw signed-URL delivery, but the frontend player (D3's component) renders a non-removable DOM/canvas overlay showing the trace code over the `<video>` element. Explicitly document in code comments and CLAUDE.md that this does **not** prevent someone from hitting the raw signed URL directly and downloading the unwatermarked original within its 60s TTL — it deters casual screen-recording only, same category as the screenshot deterrents in D3.

Whichever you pick, the `traceCode` for video must be generated the same way as D1 (reuse the helper, don't fork the logic) and logged to `AuditLog` the same way.

- **Acceptance:** `GET /api/content/:contentId/serve` for a `VIDEO` content type returns evidence of the chosen approach (either a watermarked file/stream marker for Option A, or a `traceCode` field in the JSON response for the frontend to render in Option B) plus an `AuditLog` row, mirroring D1's audit trail.

### D3 — Client-side protection component (`apps/web`)

Since no content-viewing page exists yet, build a standalone, reusable piece that a future session wires into the real viewer:

- `apps/web/src/components/ProtectedMedia.tsx` (or similar) — a wrapper component that, for its children media element:
  - Disables the context menu (`onContextMenu` preventDefault) over the wrapped region.
  - Disables drag-start / text-selection over the wrapped region (CSS `user-select: none` + `draggable={false}`).
  - Pauses `<video>` playback and blurs `<img>`/`<video>` content when the tab loses visibility (`document.visibilitychange`) or the window loses focus (`blur` event) — resumes/unblurs on return.
  - Renders the D1/D2 `traceCode` as a persistent, low-opacity overlay label (not just relying on the server-burned mark, for the image case too — belt and suspenders, and mandatory for Option B video).
- A minimal demo route, `apps/web/src/app/dev/protected-media/page.tsx`, exercising the component against a static placeholder image and a placeholder `<video>` so it can be manually verified without a real signed URL — matches the wallet page's precedent of a small standalone screen.
- Explicit code comment (mirrored in the component's JSDoc) stating plainly: **these are deterrents, not security controls; no web page can block an OS-level screenshot or an external capture device.** Do not let this be implied anywhere as a leak-proof guarantee.
- **Acceptance:** component-level tests (Vitest + `@testing-library/react`, new devDependency — justify the addition of jsdom env) asserting: context menu is prevented, `visibilitychange`/`blur` toggle the expected blur/pause state, and the trace-code overlay renders the passed-in prop.

### D4 — Storage hygiene: purge orphaned objects

Resolve both flagged Open Items with one cleanup job, following the existing daily-cron-sweep pattern from Session 06.5 (`subscriptions/renewals/run`):

- `POST /api/admin/storage/cleanup/run` — service-secret protected (mirror `PAYOUT_CRON_SECRET`/`secretMatches` timing-safe pattern exactly), triggered by a new GitHub Actions workflow (`.github/workflows/storage-cleanup.yml`, daily).
- Sweeps and deletes the underlying storage object (via `StorageClient.deleteFile`) for:
  - `Content` rows where `deletedAt` is not null (Session 04 gap).
  - `GenerationJob` rows where `status = 'COMPLETED'` and `expiresAt` has passed (Session 08 gap).
- Batched/paginated (reuse the cursor pattern from `GET /api/generations`) — do not load the whole table into memory.
- Idempotent: a row whose storage object is already gone (or whose `storageKey` was already nulled by a prior sweep run) is skipped without error. Consider nulling `storageKey` after a successful delete so a re-run is a fast no-op — this also finally makes the "storageKey never exposed" guarantee literally true at rest, not just in API responses.
- Writes a summary `AuditLog` row (counts deleted/skipped/failed) per run, same shape as the payout run summary.
- **Acceptance test:** seed one soft-deleted `Content` row and one expired `COMPLETED` `GenerationJob` with real objects in the fake storage mock; run the sweep; assert `deleteFile` was called for both and `storageKey` is nulled after; run it again and assert zero further delete calls (idempotency).

---

## Security Requirements

- `WATERMARK_TRACE_SECRET` (new env var, min 32 chars) is added to `src/lib/env.ts`'s eager startup validation, following the exact pattern of `JWT_SECRET`/`JWT_REFRESH_SECRET` — missing value crashes at boot, not at first request.
- The cleanup endpoint uses the same timing-safe `secretMatches` comparison as `/api/payouts/run` and `/api/subscriptions/renewals/run` — no plain `===` on a secret, ever.
- No new endpoint may read or return `storageKey` in any response body, including the cleanup run's summary (counts and IDs only).
- Trace-code generation must not introduce a timing side-channel that reveals whether a `contentId`/`viewerId` pair has been served before (deterministic HMAC output is fine; just don't branch response timing on cache hits in a way that leaks this).
- If Option A (ffmpeg) is chosen for D2: the ffmpeg invocation must not shell out with any user-controlled string unsanitized (path/filename injection) — use the library's programmatic API, not a raw shell command built from request data.
- Rate limiting on the demo route is not required (it's a dev-only page with no real data), but it must not be reachable with real signed URLs or real `storageKey`s — placeholder assets only.

## Performance Requirements

- The added trace-code HMAC computation must not measurably regress the existing on-the-fly watermark latency — it's a single synchronous HMAC + a slightly longer SVG overlay string, not a new round-trip.
- The storage cleanup sweep must process in bounded batches (suggest 100 rows/batch) so a large backlog doesn't hold a long-lived transaction or block the event loop.
- If Option A (server-side video burn-in) is chosen, it must respect a timeout bound analogous to `GENERATION_TIMEOUT_MS` and fail closed (serve nothing rather than hang) rather than block the request indefinitely.

## Tech Choices Guidance

- Justify D2's Option A vs Option B choice explicitly against this project's stated philosophy: low-cost, serverless-friendly, avoid heavy native dependencies unless the security gap genuinely warrants it.
- Justify any new frontend testing dependency (`@testing-library/react`, jsdom environment) the same way prior sessions justified new deps.
- Reuse existing patterns wherever one exists (cron-secret auth, cursor pagination, `AuditLog`, `StorageClient`) rather than inventing parallel mechanisms — flag it in your summary if you deviate and why.

---

## Definition of Done

- [x] D1: per-viewer forensic watermark on images, wired into both image-serving endpoints, with non-leakage test — `modules/protection/trace.ts` (HMAC-SHA256 → 8-char base32), `content.service.serve` + `generation.service.serveImage`, `protection.test.ts` (window-substring non-leakage test)
- [x] D2: video protection approach chosen, implemented, and justified in CLAUDE.md Architecture Decisions — **Option B** (client overlay + documented residual risk); `/serve` for VIDEO returns `traceCode` + AuditLog row via the same helper
- [x] D3: `ProtectedMedia` component + demo route + component tests, explicitly documented as deterrent-only — `apps/web/src/components/ProtectedMedia.tsx` (+ 7 RTL/jsdom tests), `apps/web/src/app/dev/protected-media/page.tsx` (placeholder assets only, 404 in production)
- [x] D4: storage cleanup sweep resolving both the Session 04 and Session 08 orphaned-object Open Items, idempotent, audit-logged — `POST /api/admin/storage/cleanup/run`, `.github/workflows/storage-cleanup.yml` (daily 07:00 UTC), migration `20260912120000_nullable_content_storage_key` applied
- [x] All deliverables implemented per acceptance criteria above
- [x] Tests written and passing, zero regressions (`pnpm turbo run typecheck lint test build` all green) — 331 API tests (22 new) + 7 web tests (first web suite); `pnpm lint` (root ESLint incl. jsx-a11y) clean
- [x] No hardcoded secrets; `WATERMARK_TRACE_SECRET` added to `env.ts` eager validation (min 32 chars, `requiredMinLength`) and both `.env.example` files; `STORAGE_CLEANUP_CRON_SECRET` mirrors the payout/renewal cron secrets
- [x] `storageKey` never exposed in any response, including the new cleanup endpoint (counts only; the summary AuditLog row carries failed row *ids*, never keys) — and now nulled at rest once purged
- [x] ARIA validation passed — `eslint-plugin-jsx-a11y` over `**/*.tsx`: one real finding on the demo page (`img-redundant-alt`) fixed; zero remaining. Component: `role="group"` + `aria-label`, `role="status"` live region for the obscured state, overlay `aria-hidden`
