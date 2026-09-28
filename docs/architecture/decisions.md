Split out of CLAUDE.md in this commit (verbatim move; no content reworded).

## Architecture Decisions

_Session 01 — all choices prioritize a free tier at MVP, TypeScript-first DX, and easy swap/upgrade later._

- **pnpm workspaces + Turborepo** — strict, symlinked, disk-efficient installs with cached task running. No vendor lock-in; both free.
- **Next.js 14 (App Router)** — SSR/ISR, file-based routing, i18n-ready, deployable to any Node/serverless host.
- **Fastify 5** — leaner than NestJS; upgraded from v4 to v5 in Session 02 to align with plugin ecosystem (@fastify/jwt@10, @fastify/cookie@11, @fastify/rate-limit@11).
- **Prisma + PostgreSQL (Supabase)** — type-safe generated client + migrations; free managed Postgres, no credit card. Generated client outputs to `apps/api/prisma/generated/` (gitignored).
- **Internal packages from source** — `@creator-platform/shared` exposes `src/` directly, no build step in dev.
- **ESLint 9 flat config + Prettier** — single root config governs every package.
- **Vitest** — ESM/TS-native; auth tests inject in-memory Prisma mock + fake emailer so CI stays green with no real DB or email.

_Session 02 — auth-specific decisions:_

- **JWT in httpOnly cookies only** — access token (15m, `JWT_SECRET`) + refresh token (7d, `JWT_REFRESH_SECRET`). Tokens are never returned in response bodies or stored in localStorage.
- **Two namespaced @fastify/jwt registrations** — separate secrets and cookies for access vs refresh tokens. Produces `reply.accessJwtSign` / `request.accessJwtVerify` / etc. Untyped decorators augmented in `src/types/fastify-jwt.d.ts`.
- **SHA-256 pre-digest before bcrypt for refresh tokens** — bcrypt silently truncates input at 72 bytes; a JWT's signature lives past that. Digesting to a fixed 64-char hex string first ensures the full token (signature included) is bound to the stored hash.
- **bcryptjs** — pure JS, avoids native build issues in CI/serverless environments.
- **Zod via manual `safeParse`** — validation at route handlers without a bridge dependency. Sufficient for MVP scale.
- **Resend** — transactional email via SDK (`resend` npm package); `Emailer` interface allows swapping providers without touching auth code.
- **Startup env validation** — `src/lib/env.ts` validates required secrets eagerly at boot; process crashes with a clear error if any are missing (never fails silently at first request).

_Session 04 — content-specific decisions:_

- **`storageKey` is layer-private** — it never enters a response body, header, or error. Delivery is exclusively via short-TTL signed URLs (≤300s thumbnails, 60s video) or on-the-fly watermarked byte streams; the serve path streams bytes directly, not a signed URL.
- **`ImageProcessor` interface (sharp-backed)** — image work sits behind an injectable interface like `StorageClient`/`Emailer`, so tests inject a fake and CI never loads sharp's native binary. Watermark is an SVG overlay (per-user: brand + email), images capped at 2048px before processing for the <500ms budget.
- **Per-user watermark ⇒ `Cache-Control: no-store`** — watermarked images are unique per requester, so they must never be cached by browsers/proxies.
- **Tier access via `ContentAccess` rows** — a `contentId+userId` join with `grantReason` + optional `expiresAt`, checked server-side on every serve/list. `grantContentAccess`/`revokeContentAccess` are the write primitives Session 05's payment webhooks will call.
- **`cuid2` for storage keys** — collision-resistant content IDs in `content/{modelId}/{cuid2}.{ext}`.

_Session 05 — payments implementation decisions:_

- **Idempotency lives in the database, not in application logic.** The correlation id minted at checkout is stored as `PaymentTransaction.idempotencyKey` (UNIQUE) and handed to the provider as its correlation/order id, so the webhook echoes it back. Confirmation is a compare-and-set — `updateMany({ where: { idempotencyKey, status: 'PENDING' } })` — so Postgres arbitrates: a replay matches zero rows and the credit/grant never runs, and two concurrent deliveries serialize on the row lock. An application-level "have I seen this id?" check has a read-then-write window both deliveries can pass through.

- **One `$transaction` per confirmed event.** The status claim, the wallet credit (or subscription upsert + `ContentAccess` grants), and the `AuditLog` row commit together. There is no instant at which a transaction reads CONFIRMED but the thing it paid for has not been granted.

- **Raw bytes for signature verification.** A JSON content-type parser scoped to the payments plugin keeps `request.rawBody`; re-serializing the parsed body changes key order and whitespace, and the digest with it. Verification runs before the first database statement, so a forged callback costs one HMAC.

- **Prices come from a server-side catalog.** `SUBSCRIPTION_PLANS` and `CREDIT_PACKS` in `@creator-platform/shared` are the only source of an amount; checkout schemas have no `amount` field, so a client can choose *what* to buy but never *for how much*.

- **Money is integer minor units.** Every persisted amount is centavos/cents as an `Int`. Crypto `payAmount` crosses the wire as a decimal string — it carries more precision than a JS number holds safely.

- **Balances cannot go negative by construction.** `debitCredits` is a conditional update (`WHERE userId = ? AND balance >= ?`); an under-funded debit matches zero rows and throws, with a `CHECK (balance >= 0)` constraint as backstop. No read-then-write, no partial mutation.

- **`nock@14` over msw for adapter tests.** nock 14 intercepts Node's global `fetch` natively — the exact surface the adapters use — and `nock.disableNetConnect()` turns any un-mocked provider call into a hard failure. msw's advantage is sharing handlers between a browser worker and Node, which does not apply to server-side HTTP clients.

- **`mock` is a valid pix/crypto adapter in development.** It makes checkout work before the Woovi and NOWPayments merchant accounts are approved, and it is what proves the abstraction holds: flipping `PAYMENT_PROVIDER_PIX` swaps the class with no other change. The **card** channel still accepts `mock` and nothing else — CCBill must be wired in deliberately, never by flipping an env var.

- **Checkout rate limits key on `userId`, not IP.** Two subscribers behind one NAT must not exhaust each other's budget, and one account must not earn a fresh budget per IP.

_Session 06 — payouts implementation decisions:_

- **A model's balance is a query, not a column.** `SUM(modelShareCents) WHERE modelId = ? AND payoutId IS NULL` is the whole definition of "what we owe you". Paying is a *claim* — stamping `payoutId` onto the rows that funded the payout — never a decrement of a counter. A counter can drift from the rows that justify it, and reconciling a drifted financial counter after the fact is not something a weekly cron job can do. Same ledger-over-counter reasoning as Session 05's `debitCredits`, applied to money out.

- **The split is stamped at confirmation, not computed at payout time.** `modelShareCents`/`platformShareCents` are written in the same `$transaction` that confirms the payment, so the row records what was owed under the terms in force *then*. Changing `REVENUE_SHARE_MODEL_PCT` next month therefore cannot silently rewrite what a model already earned. Rounding is remainder-to-platform (`platform = amount − model`), backed by a CHECK constraint, so no cent leaks or is invented.

- **Claiming is compare-and-set, and failure releases the claim.** The run creates the `Payout` and claims its transactions in one `$transaction` with `updateMany({ where: { id: { in: ids }, payoutId: null } })`; if the matched count differs from what was selected, another run got there first and the whole transaction aborts. If the provider then rejects the batch, the `Payout` goes FAILED and every `payoutId` is reset to null — the earnings simply reappear in next week's balance. There is no state in which money is claimed but unpayable.

- **`/payouts/run` is guarded by a service secret, not an admin JWT.** The caller is a GitHub Actions cron job: it has no user session, so it has no JWT to present and no way to get one without holding a real admin password — and there is no admin auth or dashboard yet (Session 11). A shared secret in a header authenticates the *machine* honestly, is compared with `crypto.timingSafeEqual`, rejects before any DB access, is rate-limited 2/hour so a leaked secret cannot trigger unlimited runs, and rotates in one GitHub secret.

- **Below-threshold balances need no carry-over bookkeeping.** A model under `PAYOUT_MIN_THRESHOLD_CENTS` is skipped, their rows keep `payoutId = null`, and the same balance query picks them up next week. The carry-over falls out of the ledger rather than being a second thing to maintain.

- **Models are processed in chunks of 10 via `Promise.allSettled`** — not sequentially (one slow Paxum call would stall the run) and not all at once (a thousand models would open a thousand sockets and trip the provider's rate limits). One failing model is one `failed` in the summary, not a dead run.

- **Credit-pack revenue is deliberately out of the split.** Credits are a wallet-wide balance with no per-model attribution until AI generation ships (Session 08), so there is nothing honest to split; `CREDIT_PACK` rows leave both shares null rather than carrying an invented number.

- **A payout destination is never inferred.** `ModelProfile.payoutEmail` is set explicitly by the model, is UNIQUE at the database level, and every change is audit-logged with its previous value. Falling back to `User.email` would have been convenient and wrong: Paxum pays into a personal account whose address need not match the login, and a wrong address is an irreversible transfer, not a validation error. A model without one is skipped — the balance is safe where it is.

- **`PaxumAdapter` ships pre-approval, like Woovi and NOWPayments did.** The Business account is not approved, so the wire format is written against Paxum's publicly documented mass-payout mechanics and exercised only against `nock`. Every provisional name is marked as such in the adapter and tracked as an Open Item. What is *not* provisional is the seam: correcting a field name later touches one class.

_Session 06.5 — subscription lifecycle decisions:_

- **"Will it renew" is a separate column from "what access is live".** `Subscription.status` means one thing: the subscriber's current access state. `cancelAtPeriodEnd` means another: whether a renewal charge will be issued. Merging them into a fifth status value would force every access check to learn a `CANCELING` state that grants full access — or force us to mark someone `CANCELED` while they still have 28 paid-for days. Kept apart, no access-control code changed at all, and churn (`CANCELED`) stays queryable apart from payment failure (`EXPIRED`), which are different business signals.

- **Renewal is a fresh charge, not a stored mandate.** PIX and crypto are one-shot instruments: there is nothing to pull from. So the sweep issues a new charge a few days early, emails it, and allows a grace window after the period ends — a design that works identically for both rails through the existing `IPaymentProvider`. Woovi's Pix Automático (a BACEN recurring mandate) would improve this for PIX subscribers specifically, and is tracked as a future candidate rather than built here.

- **One `IPaymentProvider` call site for subscription revenue.** `issueSubscriptionCharge` is called by both the checkout endpoint and the renewal sweep. A renewal is not a different kind of payment, and duplicating the call site would have meant two places to keep the catalog price, the eligibility gates and the idempotency key in step.

- **The sweep is idempotent by query, not by claim.** Unlike the payout run it moves no money by itself, so it needs no claim/rollback machinery: reminders are guarded by "does an unpaid `SUBSCRIPTION` charge already exist for this pair", and each transition is an `updateMany` whose `where` names the status being moved *from*. Re-running matches zero rows.

- **The renewal rail comes from the last confirmed payment's currency.** `Subscription.provider` names an adapter, not a channel, so it cannot answer which rail to renew on. `channelForCurrency` inverts the existing `CHANNEL_CURRENCY` table instead of introducing a second mapping to keep in sync; a subscription with no confirmed payment is skipped and audited rather than renewed on a guess.

_Session 07 — real-time messaging decisions:_

- **`@fastify/websocket`, self-hosted, over a managed pub/sub.** It runs inside the existing Fastify process, so real-time delivery costs no new hosted service and needs no second identity system — the socket authenticates through the same httpOnly cookie and `authenticate` hook the REST routes already use, because a WebSocket upgrade is still an HTTP request. Pusher/Ably (CLAUDE.md's original "optional" prerequisite) would mean paying per connection and shipping the subscriber graph to a third party for something a single MVP instance serves for free. Socket.IO was rejected too — its own protocol, client library and room semantics solve problems this session doesn't have.

- **The WebSocket is broadcast-only; there is exactly one place a message is written.** `POST /api/messages/conversations/:id/messages` is the only creation path — the socket ignores every inbound frame. This is the same "one call site" discipline as Session 06.5's `issueSubscriptionCharge`: one path to validate, gate and rate-limit, with fan-out reduced to a pure read-side concern.

- **Subscription gating is re-read live on every send, never cached from conversation creation.** A subscriber's `Subscription.status` can change (lapse, cancel, resume) between opening a conversation and sending message #50; caching the check at creation time would let a lapsed subscriber keep messaging indefinitely. The model is never gated by the same check — blocking a model from answering a paying customer's last message because that customer's billing lapsed would be the wrong failure mode for a creator-monetization product.

- **404, not 403, for a non-participant on any conversation/message/attachment endpoint.** Identical reasoning to Session 06's payout-detail endpoint: a 403 confirms the id exists, turning it into an enumeration oracle. A 404 makes "wrong id" and "not yours" indistinguishable.

- **`attachmentStorageKey` never leaves the service layer.** `toMessageItem` (the only function that turns a `Message` row into client-visible JSON) has no field for it — the same "not in the output type, so no caller can leak it by forgetting to strip it" property `Content.storageKey` and `ReferenceImage.storageKey` already have. Delivery is exclusively a 60-second signed URL, minted per-request after a participation check.

- **`MessageAttachmentType` is its own enum, not a reuse of `ContentType`.** Chat attachments (15 MB image / 100 MB video cap) and the monetized content library (50 MB / 500 MB) are different products with different futures; sharing an enum would couple caps that need to move independently.

- **The fan-out registry (`connections.ts`) is process-local by design, not by oversight.** A single MVP instance needs nothing more elaborate than an in-memory `Map<userId, Set<socket>>`. Horizontal scaling of the API would need a shared layer (Redis pub/sub or similar) so an event reaches a recipient connected to a *different* process — logged as an Open Item, deliberately not solved in this session. The service only depends on an injected `send(userId, event)` seam, so that swap stays in the wiring layer.

_Session 09 — anti-leak & content protection decisions:_

- **Video: Option B (client overlay + documented residual risk), not ffmpeg burn-in.** Per-viewer tracing on video needs a per-*view* transcode — a burn-in at upload would give a per-model mark, not a per-viewer one, so it does not even answer the question. A per-view transcode of a 500 MB file is minutes of CPU per serve, far outside anything a synchronous request can bound the way `GENERATION_TIMEOUT_MS` bounds a generation, and it would have to run somewhere: ffmpeg is a heavy native binary that does not fit a serverless-friendly, free-tier-first stack, and offloading it means a job queue, worker fleet and transcoded-output storage — a whole subsystem for one feature. Option B costs zero new dependencies, gives every video view a per-viewer code with the same audit trail as images, and is honest about what it does not do: the signed URL still points at the unmarked original for its 60 s TTL, and someone who fetches it directly gets that. That gap is written down in the service, the shared type, the component and here, rather than papered over. Revisit only if a real leak investigation shows the raw-URL path being used — at which point an async, off-request per-model burn-in (not per-viewer) is the realistic next step.

- **The trace code is an HMAC, resolved only through the AuditLog.** A code found on a leaked screenshot must identify the viewer to *us* and to nobody else. Burning the email or user id (Session 04 did burn the email) leaks PII into the very file that leaked. HMAC-SHA256 under `WATERMARK_TRACE_SECRET` over `(entityId, viewerId, minute)` is opaque without the key, cheap (one synchronous digest, no round-trip, constant work whatever the inputs — no timing side-channel on serve history), and deterministic within a minute so a refresh does not spray distinct marks. The AuditLog row written per serve is the *only* lookup table; hence the key is required at boot in every environment with a 32-char floor — a short key makes offline brute force of a code feasible.

- **`AuditLog` reused, no parallel table.** The forensic lookup (`metadata.traceCode = ?`) is a rare, manual, investigative query; every other "who did what" record in the codebase already lives in `AuditLog`, and the row shape (`actorId` = viewer, `entity`/`entityId` = what was served) needs nothing the model does not have. A dedicated table would earn its keep only if lookups become routine — then a JSON index on `metadata->>'traceCode'` is the first step, not a new model.

- **The trace is composed into the label by the service; `ImageProcessor` is untouched.** The processor renders text; which text is a policy the service already owned. Keeping the interface stable meant the sharp binding, its interface and every test fake stayed as Session 04 left them.

- **Storage cleanup: delete-then-null with a compare-and-set, keyset-paged.** Same ledger discipline as payouts: the object is deleted, then the row is *claimed* by nulling `storageKey` where it still equals the key just deleted. A crash between the two leaves a key pointing at nothing, which the next run deletes again (a no-op) and nulls; two overlapping runs cannot double-count because only one CAS matches. Nulling the key is also what makes "storageKey never exposed" true at rest and the re-run a fast no-op — purged rows are excluded by the query itself. Pages are bounded (100) and walked by `id > lastId` so a large backlog is many short queries, never one scan.

- **`ProtectedMedia` is a deterrent and is labelled as one.** Right-click, drag and tab-switch protections raise the cost of casual capture and keep the trace code in frame; they cannot and do not claim to stop an OS screenshot, a recorder or a camera. The real controls stay server-side. The demo route ships with placeholder assets only and 404s in production.

- **`@testing-library/react` + jsdom for the first web suite.** The component is entirely DOM behaviour (a prevented `contextmenu`, `visibilitychange`, `blur`/`focus`, `HTMLMediaElement.pause`) — meaningless in the API suite's `node` environment. jsdom is the lightest environment that implements those; RTL queries the DOM the way a user (and the jsx-a11y rules) perceive it, and is the React 18 standard (`react-test-renderer` is deprecated and cannot dispatch real DOM events). `esbuild.jsx: 'automatic'` in the Vitest config avoids a Vite React plugin for a test-only concern. Both are devDependencies of `apps/web` only.

_Session 10 — i18n & multilingual decisions:_

- **`next-intl` over a hand-rolled solution or `react-i18next`.** App Router server components need translations resolved *before* render, not after hydration — `next-intl`'s `getRequestConfig` hook is exactly that seam, plus typed message keys and ICU pluralisation for free. `react-i18next` is a client-rendering-first library; using it here would mean either losing server rendering for translated text or bolting on a parallel server mechanism `next-intl` already provides natively.
- **Cookie-only routing over `/en/`-prefixed paths.** A prefix is what earns its keep for SEO on public, crawlable pages; this platform is auth-gated end to end (every route sits behind login except the marketing splash), so there is no public page a prefix would help rank, and adding one would mean rewriting every absolute link the API already emits (`/verify-email?token=…`, `/subscriptions`) to be locale-aware. A cookie the switcher writes, read ahead of `Accept-Language` on every request, gets the same "first byte in the right language" outcome with zero routing changes.
- **`Record<Locale, string>` for catalog labels, not a `labelKey` into a message catalog.** Both the API (email, provider charge descriptions, `GenerationJob.userPrompt`) and the web app read these labels, and the API deliberately carries no i18n runtime for two small templates — a `labelKey` would need a second lookup mechanism there. A record is an in-memory property read on every hot path (checkout, generation), and the type itself enforces key parity: an entry missing a locale does not compile.
- **`GenerationJob.userPrompt` and provider charge descriptions store the canonical (English) label, not the viewer's language.** A generation record is evidence of what was requested; letting its stored language drift with whichever locale the subscriber happened to be using would make otherwise-identical requests produce different database rows. The stable `presetId` is kept alongside for any future display-time resolution — the canonical string is for audit/record-keeping, not rendering.
- **A plain `Record<Locale, template>` map for transactional email, not an i18n runtime on the API.** Two templates (verification, renewal reminder) do not justify a dependency; this is the same small-keyed-map shape the codebase already uses for `CHANNEL_CURRENCY`. `escapeHtml` is threaded through every interpolated value in both locales at the single point each raw string enters, so no localized template can skip it.
- **`User.preferredLocale` is a plain `String` with a Zod allowlist, not a Prisma enum.** A DB enum migration is the wrong cost for "add a third supported language" — a pure application-layer allowlist change is. The read side still narrows defensively (an unrecognised stored value resolves to the default), so a hand-edited row can never surface as anything outside the allowlist.

_Session 11 — admin console decisions:_

- **Approval is a column on `ModelProfile`, not a reuse of `User.isVerified`.** Email verification proves an inbox; approval records a human decision that this person may take money on the platform. Folding the two into one flag would either block every model until an admin clicks (breaking the email flow) or let anyone with a verified inbox monetize (the pre-Session-11 state the spec called out). The gate is added *alongside* the existing checks in the two seams that matter — `content.service.upload` and `payments.service.issueSubscriptionCharge` — so the renewal sweep inherits it for free.

- **RBAC is applied at plugin scope, and rate limits run after it.** `authenticate` + `authorize('admin')` are `addHook('preHandler')` on the admin plugin, so a new route cannot forget them. Rate limits are route-level `app.rateLimit()` preHandlers rather than `config.rateLimit`: the config form is an `onRequest` hook, which runs before the cookie is verified, so a userId keyGenerator there only ever sees the IP — and an anonymous flood would burn an admin's budget before being refused. In the preHandler form the 401/403 lands first and the budget really is per admin.

- **One implementation per action, reused across entrances.** The admin's payout run is `runPayouts` with a different trigger, not a copy; report resolution unpublishes through `contentService.setPublish` with the admin role and suspends through the same `suspendUser` the users screen calls. A rule that exists twice will drift; a rule that exists once is what the audit trail describes.

- **An admin cannot act against an admin.** `suspendUser` refuses an ADMIN target before any write and before any audit row. A compromised admin session is the threat model; the smallest thing that keeps the rest of the team able to respond is that this endpoint cannot lock them out.

- **Metrics are a fixed set of `groupBy`s, and money never crosses a currency line.** Seven aggregate queries whatever the table sizes (query-count test, Session 07 style). The estimated recurring revenue buckets by the subscription's adapter (`WOOVI → BRL`, `NOWPAYMENTS → USD`) because that is the only aggregate-safe currency signal a `Subscription` row carries; anything unattributable (the offline mock) is counted separately rather than guessed. The FX policy is still the deferred Open Item — the dashboard shows the gap instead of hiding it.

- **The client-side gate is a convenience and says so.** `AdminGate` redirects non-admins so they never see an empty console; every endpoint it talks to is `authorize('admin')` on the server, and a caller who skips the component gets 401/403 on every request. The security boundary did not move to the browser.

- **Every state-changing action goes through one `ConfirmAction`.** The "explicit confirmation before firing" requirement is a property of a single component rather than a discipline each page has to remember: first click reveals, Confirm fires, a required reason gates Confirm. Reasons and report details are rendered as React text nodes (escaped), never as HTML.

- **Hand-rolled table + pager, no UI library.** The listings are five tables over one `{ total, limit, offset }` envelope; an offset pager is ~30 lines, and a table library's value (sorting, virtualisation, column resizing) is not something an MVP console with ≤100 rows per page needs. Same "no new dependency" bar as D1–D5.

_Session 12 — security hardening & performance decisions:_

- **`trustProxy` comes from `TRUST_PROXY` and can never be `true`.** Every IP-scoped budget (register, login, refresh, webhooks, cron runs) keys on `request.ip`. With `true`, any client writes its own `X-Forwarded-For` and gets a fresh budget per request; with the default `false`, a deployment behind a proxy would see the proxy as every client. A hop count or CIDR list is the only honest setting, so `true` crashes at boot and the value is set per deployment (Session 13).

- **`@fastify/helmet` over hand-set headers.** It is the maintained Fastify binding of `helmet`, applies from one hook to every reply (errors and 404s included), and keeps each header's syntax someone else's tested problem. The API serves no HTML, so its CSP is `default-src 'none'`.

- **One error handler decides what a client may see.** Routes keep answering their own typed errors with `{ error }` bodies; anything that reaches the root handler with a 5xx (or no status) becomes `{ error: 'internal_error' }` and is logged in full server-side. A Prisma error quotes SQL, a provider error can quote a payload, a stack names files — none of that is ever a response. Other 4xx are passed to Fastify's default handler unchanged, so no existing client-visible body moved.

- **The route inventory is a test, not a convention.** "Every route is authenticated and rate-limited unless it says why not" is enforced by building the real server and checking each route against two commented allowlists that also fail when they go stale. It runs at boot only (`onRoute` + one `onReady` pass). Gaps it found were closed with the existing patterns — per-user `app.rateLimit()` after auth, IP `config.rateLimit` where no user exists yet — not allowlisted.

- **Timing and algorithm are part of authentication.** An unknown email now costs the same cost-12 bcrypt compare as a wrong password, and both JWT namespaces pin HS256 on verify as well as sign, so the token header cannot choose the algorithm.

- **Web CSP: per-request nonce + `'strict-dynamic'`, set in middleware** (renamed to proxy in Session 12.6 — `src/proxy.ts`)**.** Next reads the nonce from the request's CSP header and stamps it on every script it renders, so only those scripts (and what they load) run — no script host allowlist and no `'unsafe-inline'` for scripts. `style-src` allows `'unsafe-inline'` because the UI uses React `style` attributes, which a nonce cannot cover and which cannot execute code. Static headers live in `next.config.mjs`, where they need no per-request work.

- **Reconciliation refunds by the stored cost and flags what it cannot verify.** A stale PENDING generation is refunded exactly its `creditsCost` through `walletService.addCredits`, behind the same CAS on PENDING as the live failure path, so a job is refunded at most once however many runs overlap. A stale payout is only flagged: Paxum's status-query API is unverified, and guessing the outcome of a money transfer is worse than asking a human. The daily flag is deduplicated by a deterministic audit-row id, so the database's primary key — not a read-then-write — enforces "once per payout per day".

- **Indexes are added only for a named read path.** `docs/performance/index-review.md` maps every hot query to the index that serves it; the migration adds only rows that table justifies (the forensic trace expression index is partial, so the write-hot `AuditLog` pays for exactly the rows that carry a code) and drops the one index that duplicated a unique constraint's leading column.

- **`autocannon` for the load baseline.** An npm devDependency (no external binary), driven from the same TypeScript toolchain, able to boot `buildServer` in the same process with every provider on its mock. Limits stay on during a run; scenarios are sized to their budgets and 429s are counted separately, so the baseline describes the real configuration.

_Session 12.6 — framework upgrade decisions:_

- **Next 16.3 (Active LTS) over 15.5 (Maintenance LTS).** Both received the August 2026 security patch that Next 14 did not; 15.5 gets critical fixes only, so moving there would have meant repeating this migration within months.

- **`middleware.ts` → `proxy.ts`, logic byte-for-byte.** Next 16 renamed the convention and runs it on the Node.js runtime. The nonce stays Web Crypto (`getRandomValues` → base64, 128 bits), which works unchanged on either runtime, so the rename is the whole change.

- **`/_next/image` is closed by configuration, not by the proxy.** The app renders no `next/image`, so the optimizer is pure attack surface — it was the RCE the Session 12 exception covered. `images: { unoptimized: true }` was verified on a real `next start` to turn a served `200 image/png` into a `404` before any optimizer code runs; the proxy matcher stayed exactly as Session 12 wrote it. If a future page wants `next/image`, removing this line is a deliberate, test-visible decision (the SSR test fails).

- **Turbopack is the build.** Next 16's default bundler builds the next-intl plugin and the workspace `shared` package from source with no extra configuration, so there is no `--webpack` fallback to maintain.

_Post-Session 05 — scope correction:_

- **PPV was scaffolded in Session 04 but is out of product scope (see original brief) — removed in a post-Session-05 correction; access to PREMIUM content is subscription-only.** `Content.ppvPriceCents` dropped (migration `20260831025136_remove_ppv`), the `ppv_purchase` grant reason retired, and `resolveAccess` now admits PREMIUM on `subscription_premium` alone (owner/admin unchanged).

_Pre-Session 05 — payment stack decisions (Stripe permanently excluded):_

- **Stripe is off-limits** — Stripe explicitly prohibits adult content, AI-generated adult content, and credit-based adult platforms. Account terminations occur without warning. This is a hard, permanent constraint.

- **All Brazilian-based processors are off-limits** — PagBank, Pagar.me, Mercado Pago, Transfeera, OrendaPay, SyncPay, Kirvano all operate under Banco Central do Brasil / Visa/Mastercard network policies that exclude adult content. Attempting to use them risks permanent account termination and MATCH list placement.

- **Woovi (OpenPix) as PIX provider (MVP)** — Brazilian fintech with CNPJ verificável, PCI DSS compliant, API REST documentada com SDK Node.js oficial. Plano percentual: 0,80% por transação (mín R$0,50 / máx R$5,00), zero setup/monthly fee. Liquidação imediata na conta Nubank PJ vinculada. Conta criada com MEI CNPJ 67.735.318/0001-91. Webhooks em tempo real com validação de assinatura. Provider swap-ready via `WooviPixAdapter implements IPaymentProvider`.

- **NOWPayments as crypto gateway (MVP)** — 0.5% service fee per transaction (1% with auto-conversion); zero setup/monthly fee. 350+ cryptocurrencies including USDT, USDC, BTC, ETH, SOL. Native recurring subscription API. Adult content explicitly permitted by ToS (prohibits only illegal/non-consensual material, not consensual adult entertainment). Forbes Advisor #1 crypto gateway 2025. 4.4/5 Trustpilot (850+ reviews). Non-custodial settlement available. Confirmed operational in iGaming and adult verticals.

- **CCBill as future card processor (deferred, post-MVP)** — CCBill is the confirmed and locked card processor for international Visa/Mastercard when the platform is ready. The deferral reason is purely financial: Visa ($950/yr) + Mastercard ($500/yr) = $1,450/yr in mandatory high-risk registration fees imposed by the card networks themselves (not CCBill-specific — every adult card processor passes these fees). When MVP revenue justifies this cost, CCBill activation requires: merchant account application (3–7 days approval), plus `CCBILL_ACCOUNT_NUMBER`, `CCBILL_SUBACCOUNT`, `CCBILL_SALT`, `CCBILL_API_USERNAME`, `CCBILL_API_PASSWORD`. The `CCBillAdapter` implementing `IPaymentProvider` is scaffolded but mocked at MVP. **Do not replace CCBill with any other card processor without explicit approval.**

- **MCC miscoding risk** — operating adult content under a non-adult MCC (e.g., 7372 SaaS, 7375 data services) to avoid high-risk fees constitutes transaction laundering. This risks permanent MATCH list placement, which bars the business from all major card processors for up to 5 years. The platform's actual content scope must drive MCC selection.

- **"Token domain" anti-pattern rejected** — creating a separate domain/company to sell payment tokens and use them on the adult platform was evaluated and rejected. This structure constitutes transaction laundering, violates processor ToS, and risks permanent blacklisting across all processors.

- **Telegram Stars — secondary/optional channel** — Stars can be used for low-ticket microtransactions (tips, supplementary credits) on Telegram bots/channels. Not a primary revenue stream due to: ~32% effective fee on mobile purchases (30% Apple/Google + ~2-3% Fragment); 21-day hold before withdrawal; 1,000 Stars minimum withdrawal; iOS filtering of explicit content by App Store policy; withdrawal goes to TON cryptocurrency (requires exchange → fiat). Integrate only as a supplementary channel if there is an active Telegram community.

- **IPaymentProvider + IPayoutProvider abstractions** — all three payment channels (PIX, crypto, card) implement `IPaymentProvider`. The active provider per channel is selected at startup via env var. Business logic (credit wallet, subscription grants, revenue share) calls only the interface. Swapping a provider = swap the adapter class only.

- **Credit wallet model** — credits are an internal currency. `CreditWallet` table tracks balance per user. Purchase (Woovi PIX webhook / NOWPayments IPN) → credit balance up. AI image generation → credit balance down. No payment triggered at generation time. Subscription grants → `ContentAccess` rows via `grantContentAccess`.

**Swap-readiness notes:** DB provider swappable behind Prisma; AI provider behind `AI_PROVIDER` env switch; storage behind S3-compatible env vars; email provider behind the `Emailer` interface; image processing behind the `ImageProcessor` interface; PIX payment provider behind `IPaymentProvider` (`PAYMENT_PROVIDER_PIX` env); crypto payment provider behind `IPaymentProvider` (`PAYMENT_PROVIDER_CRYPTO` env); card payment provider behind `IPaymentProvider` (`PAYMENT_PROVIDER_CARD` env, mocked until CCBill activation); payout provider behind `IPayoutProvider` (`PAYOUT_PROVIDER` env — `PaxumAdapter` / `MockPayoutProvider`, Session 06). All three payment channels were exercised through the abstraction in Session 05: swapping `PAYMENT_PROVIDER_PIX` from `woovi` to `mock` changes the adapter class and nothing else.
