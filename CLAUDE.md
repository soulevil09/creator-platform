# CLAUDE.md — Creator Platform

## Project Overview
A content monetization platform (OnlyFans-style) with AI-powered image personalization for subscribers.
Models authorize use of their likeness for AI-generated personalized images. Subscribers pay for preset
options or custom prompts. A hidden system prompt anchors the model's likeness behind every AI request.

**GitHub:** https://github.com/soulevil09/creator-platform  
**Content category:** Adult (18+) — payment stack chosen accordingly (Stripe is permanently excluded)  
**Supported currencies:** USD, BRL, EUR  
**Base languages:** PT-BR, EN (i18n-ready)  
**Budget philosophy:** Start lean with free-tier/serverless tools. Architecture must support swapping to
more robust/expensive services as revenue scales.

---

## Tech Stack

| Layer | Choice | Justification |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Fast, disk-efficient, strict symlinked workspaces; Turborepo caches build/lint/test. Free, no lock-in. |
| Frontend | Next.js 16.3 (Active LTS) + React 19 | TypeScript-first React, SSR/ISR, file routing, serverless-friendly deploy, i18n-ready. Upgraded from Next 14 / React 18 in Session 12.6 (Turbopack build, `proxy.ts` convention). |
| Backend | Fastify 5 | Lean, fast, low-overhead. Upgraded from v4 to v5 in Session 02 to align with plugin majors. |
| ORM / DB | Prisma + PostgreSQL (Supabase) | Type-safe client, migrations, swappable provider. Supabase = managed free Postgres, no card. |
| Auth | JWT (access 15m + refresh 7d) — httpOnly cookies, RBAC | Stateless, framework-agnostic, refresh-token rotation. Implemented in Session 02. |
| Storage | Supabase Storage (S3-compatible) | Finalized Session 03. Accessed via `@aws-sdk/client-s3` so the same code works against Cloudflare R2 / AWS S3 if swapped. Signed URLs via the presigner (local HMAC). |
| Email | Resend | Free tier, simple API for transactional email. Active from Session 02. |
| AI Images | Replicate — `tencentarc/photomaker` (SDXL + stacked ID embeddings) | Implemented Session 08. Plain text-to-image SDXL cannot anchor a specific face; PhotoMaker conditions on 1–4 reference photos of the same person, which is exactly `ReferenceImage` (Session 03). Pay-per-use, no subscription. Provider-swappable via `IAIProvider` / `AI_PROVIDER`; wire format provisional until a live Replicate account is approved — see Open Items. |
| Payments (PIX/BR) | **Woovi (OpenPix)** | Brazilian fintech, CNPJ-backed, PCI DSS compliant. PIX nativo com liquidação imediata. Plano percentual: 0,80% por transação (mín R$0,50 / máx R$5,00). Zero setup/monthly fee. API REST documentada, webhooks em tempo real, SDK Node.js oficial. Conta PJ criada com MEI CNPJ 67.735.318/0001-91, chave PIX CNPJ vinculada ao Nubank PJ. |
| Payments (crypto) | **NOWPayments** | 0.5% per transaction, zero setup/monthly fee. 350+ cryptocurrencies + stablecoins (USDT, USDC). Native subscription/recurring billing API. Adult content explicitly permitted by ToS. Forbes Advisor #1 crypto gateway 2025. Non-custodial option available. |
| Payments (card — deferred) | _(CCBill — locked, post-MVP)_ | CCBill is the confirmed future card processor for international Visa/Mastercard. Requires Visa ($950/yr) + Mastercard ($500/yr) high-risk registration fees — deferred until platform generates enough revenue to absorb. Architecture is abstraction-ready on day one. |
| Model payouts | **Paxum** mass payout REST API | Industry-standard for adult creator payouts. Implemented Session 06 as `PaxumAdapter implements IPayoutProvider`, selected via `PAYOUT_PROVIDER`. Weekly run triggered by a GitHub Actions cron job hitting `POST /api/payouts/run` behind a timing-safe service secret. 80/20 split (model/platform), R$50 minimum threshold. Wire format is provisional until the Business account is approved — see Open Items. |
| Lint / Format | ESLint 9 (flat) + Prettier | One root config governs all packages; modern TS standard. |
| Tests | Vitest (+ `@testing-library/react` / jsdom for `apps/web`, Session 09) | ESM/TS-native, Jest-compatible, fast. In-memory mocks for DB + email in auth tests. The web package got its first suite in Session 09: jsdom environment for DOM-behaviour tests, RTL for user-perceived queries. |
| CI | GitHub Actions | Free tier, native GitHub integration. |

> ⚠️ **Stripe is permanently excluded** from this project. Stripe explicitly prohibits adult content, AI-generated adult images, and credit-based adult platforms. Any suggestion to use Stripe must be rejected.

> ⚠️ **All Brazilian-based processors (PagBank, Pagar.me, Mercado Pago, Transfeera, OrendaPay, SyncPay, Kirvano) are incompatible** with adult content under Banco Central do Brasil and Visa/Mastercard network policies. Never suggest them.

> 📋 **CCBill is the locked future card processor** — do not replace it with anything else when cards are activated. The $1,450/yr Visa+MC registration fee is a Visa/Mastercard network requirement, not CCBill-specific — it applies to any adult card processor.

- **MCC miscoding risk** — operating adult content under a non-adult MCC (e.g., 7372 SaaS, 7375 data services) to avoid high-risk fees constitutes transaction laundering. This risks permanent MATCH list placement, which bars the business from all major card processors for up to 5 years. The platform's actual content scope must drive MCC selection.
- **"Token domain" anti-pattern rejected** — creating a separate domain/company to sell payment tokens and use them on the adult platform was evaluated and rejected. This structure constitutes transaction laundering, violates processor ToS, and risks permanent blacklisting across all processors.

---

## Engineering Invariants

Rules every new change must follow. Each is true in the current code; the pointer names where the reasoning lives.

**Money & ledger**
- Store every amount as integer minor units; crypto `payAmount` travels as a decimal string. (→ decisions.md § Session 05)
- Take prices only from the server-side catalogs (`SUBSCRIPTION_PLANS`, `CREDIT_PACKS`, generation presets); no request schema carries an amount. (→ decisions.md § Session 05)
- Debit credits only through `walletService.debitCredits` (conditional `updateMany` on `balance >= amount`); never read-then-write a balance. (→ decisions.md § Session 05)
- Never store a model's payable balance — derive it from unclaimed, confirmed `SUBSCRIPTION` rows' `modelShareCents`. (→ decisions.md § Session 06)
- Stamp the split with `computeRevenueSplit` in the confirming transaction (remainder to platform); never recompute a past split. (→ decisions.md § Session 06)
- Pay by claiming rows (`payoutId`) with a count-checked CAS; on provider failure mark the `Payout` FAILED and release every claim. (→ decisions.md § Session 06)
- Pay only to `ModelProfile.payoutEmail`; never fall back to `User.email` — skip the model instead. (→ decisions.md § Session 06)
- Issue every subscription charge through `paymentsService.issueSubscriptionCharge`. (→ decisions.md § Session 06.5)
- Never sum money across currencies; report `{ currency, amountCents }` arrays. (→ decisions.md § Session 11)

**Idempotency & concurrency**
- Enforce idempotency with a DB constraint or a compare-and-set whose `where` names the from-state — never an app-level "seen it?" check. (→ decisions.md § Session 05)
- Apply a confirmed event's status change, grant/credit, split and `AuditLog` row in one `$transaction`. (→ decisions.md § Session 05)
- Express "at most one pending" rules as partial unique indexes and map P2002 to a clean response. (→ sessions.md § Session 08, § Session 11)
- Make every sweep idempotent by its own query, so a re-run matches zero rows. (→ decisions.md § Session 06.5)
- Deduplicate periodic audit flags with a deterministic primary key, not read-then-write. (→ decisions.md § Session 12)
- Keep access state (`Subscription.status`) apart from renewal intent (`cancelAtPeriodEnd`); add no "canceling" status. (→ decisions.md § Session 06.5)

**Auth & RBAC**
- Keep JWTs in httpOnly cookies only, pinned to HS256 on sign and verify; never in a body or localStorage. (→ decisions.md § Session 02, § Session 12)
- Guard routes with `authenticate` + `authorize(...)` (lowercase roles); take the acting user id from the JWT, never the body or query. (→ sessions.md § Session 03, § Session 06)
- Answer 404, not 403, when a caller asks for a resource that is not theirs. (→ decisions.md § Session 07)
- Attach admin auth as plugin-scoped hooks; an admin can never suspend an admin. (→ decisions.md § Session 11)
- Check `suspendedAt` only where sessions are minted: login and refresh. (→ sessions.md § Session 11)
- Treat client-side gates (`AdminGate`, `ProtectedMedia`) as convenience or deterrent; the server is the boundary. (→ decisions.md § Session 09, § Session 11)
- Keep the unknown-email login path timing-equal via the dummy cost-12 bcrypt compare. (→ decisions.md § Session 12)
- Monetization gates: content upload and subscription charges require `ModelProfile.approvalStatus = APPROVED`; generation requires a live `aiConsent` check and at least one `ReferenceImage`. (→ sessions.md § Session 08, § Session 11)
- Re-read `Subscription.status` live on every gated action (e.g. message send); never cache it from an earlier request. (→ decisions.md § Session 07)

**Rate limiting**
- Key per-user limits with `app.rateLimit()` in a `preHandler` placed after `authenticate`/`authorize`; never `config.rateLimit` with a userId `keyGenerator`. (→ decisions.md § Session 11)
- Use IP-keyed `config.rateLimit` only where no user exists yet. (→ decisions.md § Session 12)
- Every route is authenticated and rate-limited, or listed in `PUBLIC_ROUTES`/`UNLIMITED_ROUTES` with a reason — `route-inventory.test.ts` fails otherwise. (→ decisions.md § Session 12)
- Never set `TRUST_PROXY=true`; use a hop count or CIDR list. (→ decisions.md § Session 12)

**Data exposure**
- Never serialize a `storageKey`/`attachmentStorageKey`; deliver media only as short-TTL signed URLs or streamed bytes. (→ decisions.md § Session 04, § Session 07)
- Let 5xx errors reach the root handler (`{ error: 'internal_error' }`); never put SQL, provider payloads or stacks in a response. (→ decisions.md § Session 12)
- New typed errors use `{ error: '<machine_code>' }` (older auth errors keep their sentence messages). (→ sessions.md § Session 07)
- Never return, persist or log (above debug) the anchor prompt; audit prompts by `hashPrompt` only. (→ sessions.md § Session 08)
- Cron responses and their summary audit rows carry aggregate counts only. (→ decisions.md § Session 06)
- Audit every change to where money goes or who may act (payout email, approval, suspension, report resolution). (→ decisions.md § Session 06, § Session 11)

**Media & storage**
- Watermark per viewer at serve time with the label from `createTraceRecorder`, `Cache-Control: no-store`; never store a marked copy, never burn PII. (→ decisions.md § Session 04, § Session 09)
- Validate uploads by magic bytes cross-checked against the declared Content-Type (`file-type`). (→ sessions.md § Session 04)
- Purge storage delete-then-null with a CAS on the key, keyset-paged by id. (→ decisions.md § Session 09)
- Keep `MessageAttachmentType` and `ContentType` separate enums. (→ decisions.md § Session 07)

**Cron routes**
- Guard cron routes with a header secret compared by length-checked `crypto.timingSafeEqual`, 401 before any DB access, and a rate limit. (→ decisions.md § Session 06)
- Never send `Content-Type: application/json` with an empty body from a cron workflow. (→ resolved-items.md)

**Providers**
- Business logic calls only `IPaymentProvider`/`IPayoutProvider`/`IAIProvider`; adapters come from a memoised env-driven factory whose boot-time assert crashes on unknown names. (→ decisions.md § Pre-Session 05, sessions.md § Session 08)
- Verify webhook signatures over the raw body before the first DB statement; verification returns `false`, never throws. (→ decisions.md § Session 05)
- The card channel accepts `mock` only until CCBill; never add Stripe or a Brazilian processor. (→ decisions.md § Session 05, § Pre-Session 05)
- Keep payments and payouts modules independent; only the pure signature helpers are shared. (→ sessions.md § Session 06)

**i18n**
- Add every UI string to both `en.json` and `pt-BR.json` (parity is test-enforced). (→ sessions.md § Session 10, § Session 11)
- Catalog labels are `Record<Locale, string>`; persisted records and provider descriptions use the canonical English label. (→ decisions.md § Session 10)
- Validate locales against the Zod allowlist; keep routing cookie-only (no path prefix). (→ decisions.md § Session 10)
- HTML-escape every interpolated value in email templates. (→ decisions.md § Session 10)

**Web**
- Mint a per-request CSP nonce in `apps/web/src/proxy.ts`; `script-src` never gets `'unsafe-inline'`, and never `'unsafe-eval'` in production; keep `images.unoptimized` so `/_next/image` stays closed. (→ decisions.md § Session 12, § Session 12.6)

**Testing & tooling**
- Mock provider HTTP with `nock` and `disableNetConnect`; inject fakes for `StorageClient`, `Emailer`, `ImageProcessor` and `test/fake-prisma.ts`. (→ decisions.md § Session 04, § Session 05)
- Run Prisma from `apps/api` (`pnpm --filter @creator-platform/api exec prisma …`), never a bare root `npx prisma`. (→ sessions.md § Session 07)
- Green means `pnpm turbo run typecheck test build`, root `pnpm lint`, and `pnpm audit --prod --audit-level=high` with no ignore list. (→ sessions.md § Session 12, § Session 12.6)

---

## Revenue Model

| Flow | Method | Notes |
|---|---|---|
| Subscriber pays monthly subscription | Woovi PIX (BR) or Crypto (NOWPayments) | Grants access to model's content tier |
| Subscriber buys credit pack | Woovi PIX (BR) or Crypto (NOWPayments) | Credits deposited to subscriber wallet |
| Subscriber spends credits | Internal debit (no new payment) | Triggers AI image generation |
| Platform pays model | Paxum API (weekly) | 80% model / 20% platform, split stamped on each confirmed SUBSCRIPTION transaction; paid Mondays 12:00 UTC above a R$50 threshold |
| _(Future)_ Subscriber pays via card | CCBill (post-MVP) | Activates when Visa/MC registration fees are sustainable |

---

## Payment Provider Abstraction

All payment business logic is decoupled from provider-specific implementations via shared interfaces.
**Every payment channel — PIX, crypto, and future card — must implement these interfaces.**
Swapping any provider = swap the adapter only. Business logic never touches provider internals.

```
IPaymentProvider
  ├── createSubscription(plan, user) → SubscriptionResult
  ├── createCreditPurchase(pack, user) → ChargeResult
  ├── cancelSubscription(subscriptionId) → void
  └── handleWebhook(payload, signature) → PaymentEvent

WooviPixAdapter      implements IPaymentProvider  ← PIX (BR market, via Woovi/OpenPix)
NOWPaymentsAdapter   implements IPaymentProvider  ← Crypto (global, via NOWPayments)
CCBillAdapter        implements IPaymentProvider  ← Card (deferred/mocked at MVP; activates post-MVP)

IPayoutProvider
  ├── createPayout(params) → PayoutResult
  ├── verifyWebhookSignature(rawBody, headers) → boolean
  └── parseWebhookEvent(rawBody) → NormalizedPayoutEvent

PaxumAdapter         implements IPayoutProvider   ← model earnings distribution
MockPayoutProvider   implements IPayoutProvider   ← tests + PAYOUT_PROVIDER=mock

MockPaymentProvider  implements IPaymentProvider  ← used in tests and for the deferred CCBill slot
```

Active providers at MVP:
- `PAYMENT_PROVIDER_PIX=woovi` → `WooviPixAdapter`
- `PAYMENT_PROVIDER_CRYPTO=nowpayments` → `NOWPaymentsAdapter`
- `PAYMENT_PROVIDER_CARD=mock` → `MockPaymentProvider` (slot reserved for CCBill)

The provider is selected at startup via env var and injected via the container. Business logic
(credit wallet, subscription grants, revenue share) calls only the interface — never the adapter.

---

## Session Map

Full per-session Summary / Notes / Prerequisites: `docs/history/sessions.md`. Specs live in `.claude/sessions/`.

| Session | Domain | Status | Summary | Spec | Pending External Prerequisites |
|---|---|---|---|---|---|
| 01 | Bootstrap | ✅ Complete | pnpm/Turborepo monorepo, Next + Fastify + shared, Prisma init, ESLint/Prettier/Vitest, CI. | `session-01.md` | — |
| 02 | Auth | ✅ Complete | Register/verify/login/refresh/logout/me, JWT httpOnly cookies, RBAC hooks, env validation. | `session-02.md` | — |
| 03 | Model Onboarding | ✅ Complete | `ModelProfile` + `ReferenceImage`, S3-compatible storage, ToS/AI-consent flow, validated uploads. | `session-03.md` | — |
| 04 | Content Management | ✅ Complete | `Content`/`ContentAccess`, upload + tiered access, on-the-fly watermarked serving, soft delete. | `session-04.md` | — |
| 05 | Payments | ✅ Complete | `IPaymentProvider`, Woovi PIX + NOWPayments + mock card, idempotent webhooks, credit wallet. | `session-05.md` | [ ] Coletar `OPENPIX_APP_ID` no dashboard → API/Plugins _(code is ready; not needed for tests)_<br>[ ] Coletar `OPENPIX_WEBHOOK_SECRET` no dashboard → Webhooks → criar webhook<br>[ ] Criar conta NOWPayments: https://nowpayments.io → Sign Up<br>[ ] Coletar `NOWPAYMENTS_API_KEY` em Store Settings<br>[ ] Coletar `NOWPAYMENTS_IPN_SECRET` em IPN Settings<br>[ ] Conectar carteira USDT TRC-20 em Payout Settings |
| 06 | Revenue Sharing & Payouts | ✅ Complete | 80/20 split stamped per transaction, ledger-derived balance, `PaxumAdapter`, weekly run, `payoutEmail`. | `session-06.md` | [ ] Create Paxum Business account: https://www.paxum.com → sign up as Business<br>[ ] Generate `PAYOUT_CRON_SECRET` (`openssl rand -hex 32`) and store it, plus `API_PUBLIC_URL`, as GitHub Actions repository secrets |
| 06.5 | Subscription Lifecycle: Renewal & Cancellation | ✅ Complete | Renewal charges + reminders, grace period, `cancelAtPeriodEnd` cancel/resume, daily sweep. | `session-06.5.md` | [ ] Generate `SUBSCRIPTION_RENEWAL_CRON_SECRET` (`openssl rand -hex 32`) and store it as a GitHub Actions repository secret (alongside the existing `API_PUBLIC_URL`) |
| 07 | Real-Time Private Messaging | ✅ Complete | Subscription-gated 1:1 messaging, attachments, broadcast-only WebSocket fan-out. | `session-07.md` | — |
| 08 | AI Image Personalization | ✅ Complete | PhotoMaker via `IAIProvider`, hidden anchor prompt, safety gate, credit debit + auto-refund. | `session-08.md` | [ ] Create Replicate account: https://replicate.com → sign up → go to https://replicate.com/account/api-tokens → generate token → copy `AI_PROVIDER_API_KEY`<br>[ ] Review the `tencentarc/photomaker` model on Replicate and confirm the pinned version hash is current<br>[ ] Add billing method on Replicate (pay-per-use): https://replicate.com/account/billing |
| 09 | Anti-Leak & Content Protection | ✅ Complete | HMAC trace codes on served media, `ProtectedMedia` deterrents, storage cleanup sweep. | `session-09.md` | [ ] Generate `WATERMARK_TRACE_SECRET` (`openssl rand -hex 32`, ≥ 32 chars) for every deployed environment — **the API will not boot without it**<br>[ ] Generate `STORAGE_CLEANUP_CRON_SECRET` (`openssl rand -hex 32`) and store it as a GitHub Actions repository secret (alongside the existing `API_PUBLIC_URL`) |
| 09.5 | Lei FELCA: Age Verification (CPF + Face ID) | ⏳ Deferred | Lei 15.211/2025 CPF + facial age verification — deferred by business decision. | `session-09.5.md` _(to be written)_ | [ ] Confirm CAF/Certta's enterprise-tier biometric face-match pricing — the self-service "Certta Start" plan (R$200–600/mo, R$1.50–2.50/consulta) covers CPF/document/background checks only; CPF alone is explicitly equated to self-declaration in ANPD's draft guide, so it does NOT satisfy the law on its own<br>[ ] Confirm CAF/Certta (or alternative: idwall, unico, Serpro Datavalid direct — the last requires SENATRAN/Credencia accreditation + a GCC intermediary, heavier onboarding) accepts adult-content platforms as a client<br>[ ] Vendor API credentials + webhook secret |
| 10 | i18n & Multilingual | ✅ Complete | `next-intl` cookie-based locale, PT-BR/EN catalogs, `preferredLocale`, localized email. | `session-10.md` | — |
| 11 | Admin Dashboard | ✅ Complete | Model approval, user suspension, metrics, admin payout run, content reports, `/admin` UI. | `session-11.md` | [ ] (Optional) Analytics: https://posthog.com → create account (free tier) → copy project API key — not taken this session |
| 11.5 | Hotfix: Per-User Rate Limits Were Silently Keying on IP | ✅ Complete | Per-user rate limits moved after `authenticate` (were keying on IP). | `session-11.5.md` | — |
| 12 | Security Hardening & Performance Audit | ✅ Complete | CI audit/build, `TRUST_PROXY`, helmet, error surface, route inventory, reconciliation, indexes. | `session-12.md` | [ ] Generate `RECONCILIATION_CRON_SECRET` (`openssl rand -hex 32`) and store it as a GitHub Actions repository secret (alongside `API_PUBLIC_URL`) and in the API environment<br>[ ] Set `TRUST_PROXY` to the real hop count (or proxy CIDRs) of the deployment — Session 13<br>[ ] Set `NEXT_PUBLIC_MEDIA_ORIGIN` to the storage host signed URLs point at, so the web CSP lets media load<br>[ ] Run `pnpm --filter @creator-platform/api load` (full mode) against a non-production database to fill in the DB-backed baseline |
| 12.5 | FX-Aware Payouts & Credit-Spend Revenue Share | ⏳ Pending | Per-currency payouts with an FX policy; credit-spend revenue share. | `session-12.5.md` _(to be written)_ | [ ] Product decision: FX policy for models earning in BRL and USD<br>[ ] Product decision: the model's share of a credit spend |
| 12.6 | Framework Upgrade: Next.js 16.3 (Active LTS) + React 19 | ✅ Complete | Next 16.3 + React 19, `proxy.ts`, `/_next/image` closed, zero audit exceptions, Node 22. | `session-12.6.md` | — |
| 13 | MVP Deployment | ⏳ Next | Deploy, managed DB, custom domain, SSL, monitoring; Redis rate-limit store + pub/sub. | `session-13.md` | [ ] Choose and create hosting account (pick one):<br>[ ] **Register a custom domain — required, not optional** (https://porkbun.com or https://namecheap.com). Web and API must be served from the same registrable domain (e.g. `app.<domain>` / `api.<domain>`): the API's CORP `same-site` and the `SameSite=Strict` auth cookies both break across sites, and platform default subdomains (`*.up.railway.app`, `*.onrender.com`, `*.fly.dev`) are on the Public Suffix List, so they count as different sites. See Open Items.<br>[ ] Set up error monitoring: https://sentry.io → create account (free tier) → create project → copy `SENTRY_DSN`<br>[ ] (Optional) Uptime monitoring: https://betterstack.com/uptime → free tier available<br>[ ] (If running more than one API instance) Upstash Redis for the rate-limit store and messaging pub/sub: https://upstash.com → create Redis DB → copy `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN` |

---

## Where the detail lives

Before changing an area, read the file that covers it:

- `docs/architecture/decisions.md` — every Architecture Decision, with its reasoning, grouped by session.
- `docs/history/sessions.md` — each session's Summary, Notes/deviations and External Prerequisites.
- `docs/history/resolved-items.md` — resolved Open Items (what was fixed, where, why).
- `docs/history/last-updated.md` — earlier "Last Updated" entries.
- `.claude/sessions/session-NN.md` — the original spec for each session.

---

## Repository Structure

```
creator-platform/
├── apps/
│   ├── web/                         # Next.js 16.3 App Router + React 19 (@creator-platform/web)
│   │   ├── messages/                # en.json, pt-BR.json catalogs (Session 10)
│   │   ├── src/app/layout.tsx       # generateMetadata + NextIntlClientProvider + LocaleSwitcher (Session 10)
│   │   ├── src/app/page.tsx
│   │   ├── src/app/wallet/page.tsx  # balance + credit-pack checkout (Session 05); localized (Session 10)
│   │   ├── src/app/dev/protected-media/page.tsx  # ProtectedMedia demo, placeholders only, 404 in prod (Session 09)
│   │   ├── src/app/admin/           # Admin console (Session 11): layout + overview, models, users, payouts, reports
│   │   ├── src/components/admin/    # AdminGate (client redirect), AdminNav, ConfirmAction (+test), Pager, api.ts, styles.ts
│   │   ├── src/proxy.ts             # per-request CSP nonce (Session 12; `middleware.ts` renamed to proxy in Session 12.6); never touches locale
│   │   ├── src/security/            # csp.ts (buildContentSecurityPolicy, createNonce) + csp.test.ts (Session 12)
│   │   ├── src/i18n/                # locale resolution + next-intl wiring (Session 10)
│   │   │   ├── locale.ts            # Zod allowlist, resolveLocale (cookie → header → default), catalog loaders
│   │   │   ├── request.ts           # next-intl getRequestConfig
│   │   │   └── global.d.ts          # typed message keys + Locale
│   │   ├── src/components/
│   │   │   ├── ProtectedMedia.tsx       # client-side capture deterrents + trace overlay (Session 09); localized (Session 10)
│   │   │   ├── ProtectedMedia.test.tsx  # 10 tests (jsdom + RTL)
│   │   │   ├── LocaleSwitcher.tsx       # EN/PT-BR switcher, writes NEXT_LOCALE cookie (Session 10)
│   │   │   └── LocaleSwitcher.test.tsx
│   │   ├── vitest.config.ts             # jsdom env, esbuild jsx automatic (Session 09)
│   │   ├── next.config.mjs              # createNextIntlPlugin (Session 10); static security headers (Session 12); images.unoptimized closes /_next/image (Session 12.6)
│   │   ├── tsconfig.json
│   │   └── .env.example
│   └── api/                         # Fastify 5 backend (@creator-platform/api)
│       ├── src/
│       │   ├── index.ts             # Server bootstrap, plugin registration, /health
│       │   ├── lib/
│       │   │   ├── env.ts           # Startup env validation (crash if secrets missing)
│       │   │   ├── prisma.ts        # Singleton PrismaClient
│       │   │   ├── email.ts         # Resend emailer + Emailer interface; Record<Locale, template> (Session 10)
│       │   │   ├── email.test.ts    # 9 tests — both locales, escaping, Intl formatting (Session 10)
│       │   │   ├── storage.ts       # S3-compatible StorageClient (+ getObject)
│       │   │   └── image.ts         # Injectable ImageProcessor (sharp): dims + watermark
│       │   ├── middleware/
│       │   │   └── auth.ts          # authenticate + authorize RBAC preHandler hooks
│       │   ├── modules/
│       │   │   ├── auth/
│       │   │   │   ├── auth.routes.ts
│       │   │   │   ├── auth.service.ts
│       │   │   │   ├── auth.schema.ts
│       │   │   │   └── auth.test.ts     # 17 tests
│       │   │   ├── onboarding/
│       │   │   │   ├── onboarding.routes.ts
│       │   │   │   ├── onboarding.service.ts
│       │   │   │   ├── onboarding.schema.ts
│       │   │   │   └── onboarding.test.ts   # 21 tests
│       │   │   ├── content/
│       │   │   │   ├── content.routes.ts
│       │   │   │   ├── content.service.ts
│       │   │   │   ├── content.schema.ts
│       │   │   │   └── content.test.ts      # 15 tests
│       │   │   ├── wallet/                  # credit wallet (Session 05)
│       │   │   ├── payments/                # money IN (Session 05)
│       │   │   │   ├── adapters/            # woovi, nowpayments, mock, http, signature
│       │   │   │   ├── provider.interface.ts + provider.factory.ts
│       │   │   │   ├── payments.routes.ts / .service.ts / .schema.ts
│       │   │   │   └── payments.test.ts     # 41 tests
│       │   │   ├── payouts/                 # money OUT (Session 06)
│       │   │   │   ├── adapters/            # paxum, mock, http
│       │   │   │   ├── provider.interface.ts + provider.factory.ts
│       │   │   │   ├── revenue.ts           # computeRevenueSplit (80/20)
│       │   │   │   ├── payouts.routes.ts / .service.ts / .schema.ts
│       │   │   │   └── payouts.test.ts      # 67 tests
│       │   │   ├── admin/                   # admin console (Session 11)
│       │   │   │   ├── admin.routes.ts / .service.ts / .schema.ts
│       │   │   │   └── admin.test.ts        # 25 tests (RBAC boundary, D1–D5, query count, run parity)
│       │   │   ├── protection/              # anti-leak (Session 09)
│       │   │   │   ├── trace.ts             # computeTraceCode (HMAC→base32) + createTraceRecorder (AuditLog)
│       │   │   │   └── protection.test.ts   # 15 tests (D1/D2 acceptance + non-leakage)
│       │   │   ├── storage-cleanup/         # orphan purge sweep (Session 09)
│       │   │   │   ├── storage-cleanup.routes.ts / .service.ts
│       │   │   │   └── storage-cleanup.test.ts  # 7 tests
│       │   │   └── reconciliation/          # stale generations refunded, stale payouts flagged (Session 12)
│       │   │       ├── reconciliation.routes.ts / .service.ts
│       │   │       └── reconciliation.test.ts   # 10 tests
│       │   ├── security/                    # Session 12
│       │   │   ├── error-handler.ts         # 5xx → internal_error, bad_request, payload_too_large, not_found
│       │   │   ├── route-inventory.ts       # boot-time auth/rate-limit inventory of every route
│       │   │   ├── route-policy.ts          # PUBLIC_ROUTES / UNLIMITED_ROUTES allowlists (with reasons)
│       │   │   ├── route-inventory.test.ts  # 6 tests
│       │   │   └── security.test.ts         # 19 tests (D1 proxy/body limit, D2 headers/errors, D4 auth)
│       │   ├── subscriptions/               # lifecycle (Session 06.5)
│       │   │   ├── subscriptions.routes.ts / .service.ts / .schema.ts
│       │   │   └── subscriptions.test.ts    # 21 tests
│       │   ├── test/
│       │   │   └── fake-prisma.ts           # shared in-memory Prisma stand-in
│       │   └── types/
│       │       └── fastify-jwt.d.ts
│       ├── prisma/
│       │   ├── schema.prisma        # User (+suspendedAt), ModelProfile (+payoutEmail, +approvalStatus), Content, payments (+cancelAtPeriodEnd) + Payout + Report models + enums
│       │   ├── migrations/          # …_add_user_model, …_add_model_profile, …_add_content_management, …_add_payments, …_remove_ppv, …_add_payouts, …_add_payout_email, …_add_subscription_lifecycle, …_add_messaging, …_add_generation_jobs, …_nullable_content_storage_key, …_add_user_preferred_locale, …_add_admin_dashboard, …_security_index_review
│       │   └── generated/           # Prisma client output (gitignored)
│       ├── scripts/
│       │   ├── postinstall.mjs
│       │   └── load/run.ts          # autocannon load baseline (Session 12) — `pnpm --filter @creator-platform/api load [--dry-run]`
│       ├── vitest.config.ts
│       ├── vitest.setup.ts
│       ├── tsconfig.json
│       └── .env.example
├── packages/
│   └── shared/                      # Framework-free types/constants/utils
│       ├── src/index.ts             # Role, JwtPayload, AuthUser + locale/currency constants; LocalizedLabel, negotiateLocale (Session 10)
│       └── src/locale.test.ts       # 6 tests — Accept-Language parser + catalog helpers (Session 10)
├── .github/workflows/
│   ├── ci.yml
│   ├── weekly-payout.yml            # Mon 12:00 UTC → POST /api/payouts/run
│   ├── subscription-renewals.yml    # daily 06:00 UTC → POST /api/subscriptions/renewals/run
│   ├── storage-cleanup.yml          # daily 07:00 UTC → POST /api/admin/storage/cleanup/run
│   └── reconciliation.yml           # daily 07:30 UTC → POST /api/admin/reconciliation/run (Session 12)
├── docs/
│   ├── security/owasp-audit.md      # OWASP Top 10 (2021) audit (Session 12)
│   └── performance/                 # index-review.md, load-baseline.md (Session 12)
├── .claude/sessions/
├── tsconfig.base.json
├── turbo.json
├── eslint.config.mjs
├── .prettierrc / .prettierignore
├── pnpm-workspace.yaml
├── .env.example
├── CLAUDE.md
└── README.md
```

---

## Environment Variables Required

Templates live in `.env.example` (root) and `apps/api/.env.example`.
All `.env*` files are gitignored; examples contain placeholders only.

| Variable | Scope | Session | Purpose |
|---|---|---|---|
| `DATABASE_URL` | api | 01 | Supabase Postgres connection string |
| `JWT_SECRET` | api | 02 | Access token signing secret (min 32 chars) |
| `JWT_REFRESH_SECRET` | api | 02 | Refresh token signing secret (min 32 chars, different value) |
| `JWT_EXPIRES_IN` | api | 02 | Access token lifetime (`15m`) |
| `JWT_REFRESH_EXPIRES_IN` | api | 02 | Refresh token lifetime (`7d`) |
| `EMAIL_API_KEY` | api | 02 | Resend API key (`re_…`) |
| `EMAIL_FROM` | api | 02 | Sender address (`noreply@yourdomain.com`) |
| `APP_URL` | api | 02 | Allowed CORS origin + base URL for email links |
| `API_PORT` | api | 01 | Fastify listen port (default `4000`) |
| `NODE_ENV` | both | 01 | Runtime environment |
| `STORAGE_ENDPOINT` / `STORAGE_BUCKET` / `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | api | 03 | Object storage |
| `STORAGE_REGION` | api | 03 | SigV4 signing region (default `us-east-1`) |
| `PAYMENT_PROVIDER_PIX` | api | 05 | Active PIX adapter: `woovi` |
| `OPENPIX_APP_ID` | api | 05 | Woovi (OpenPix) App ID — Dashboard → API/Plugins |
| `OPENPIX_WEBHOOK_SECRET` | api | 05 | Woovi webhook signature secret — Dashboard → Webhooks |
| `OPENPIX_API_URL` | api | 05 | Woovi API base URL (default `https://api.woovi.com`) |
| `PAYMENT_PROVIDER_CRYPTO` | api | 05 | Active crypto adapter: `nowpayments` |
| `NOWPAYMENTS_API_KEY` | api | 05 | NOWPayments API key |
| `NOWPAYMENTS_IPN_SECRET` | api | 05 | NOWPayments IPN (webhook) secret |
| `NOWPAYMENTS_API_URL` | api | 05 | NOWPayments API base URL (default `https://api.nowpayments.io`) |
| `NOWPAYMENTS_PLAN_ID_STANDARD` / `_PREMIUM` | api | 05 | Optional recurring-plan ids; blank = skip provider-side recurrence |
| `API_PUBLIC_URL` | api | 05 | Internet-reachable base URL the providers post webhooks to |
| `PAYMENT_PROVIDER_CARD` | api | 05 | Active card adapter: `mock` (CCBill when activated post-MVP) |
| `CCBILL_ACCOUNT_NUMBER` | api | _post-MVP_ | CCBill main account number (6-digit) — deferred |
| `CCBILL_SUBACCOUNT` | api | _post-MVP_ | CCBill subaccount number (4-digit) — deferred |
| `CCBILL_SALT` | api | _post-MVP_ | CCBill webhook HMAC salt — deferred |
| `CCBILL_API_USERNAME` | api | _post-MVP_ | CCBill REST API username — deferred |
| `CCBILL_API_PASSWORD` | api | _post-MVP_ | CCBill REST API password — deferred |
| `PAYOUT_PROVIDER` | api | 06 | Active payout adapter: `paxum` (or `mock` for offline dev) |
| `PAXUM_API_KEY` | api | 06 | Paxum REST API key for mass payouts |
| `PAXUM_IPN_SECRET` | api | 06 | Paxum IPN shared secret for webhook validation |
| `PAXUM_API_URL` | api | 06 | Paxum API base URL (default `https://api.paxum.com`) |
| `PAYOUT_CRON_SECRET` | api | 06 | Shared secret for `POST /api/payouts/run` (timing-safe compare); mirrored as a GitHub Actions repo secret |
| `REVENUE_SHARE_MODEL_PCT` | api | 06 | Model's cut of a confirmed subscription, whole percent (default `80`) |
| `PAYOUT_MIN_THRESHOLD_CENTS` | api | 06 | Minimum payable balance in minor units (default `5000` = R$50) |
| `PAYOUT_CURRENCY` | api | 06 | Currency Paxum settles payouts in (default `BRL`) |
| `SUBSCRIPTION_RENEWAL_CRON_SECRET` | api | 06.5 | Shared secret for `POST /api/subscriptions/renewals/run` (timing-safe compare); mirrored as a GitHub Actions repo secret |
| `SUBSCRIPTION_RENEWAL_REMINDER_DAYS` | api | 06.5 | Days before `currentPeriodEnd` the renewal charge + reminder go out (default `3`) |
| `SUBSCRIPTION_GRACE_PERIOD_DAYS` | api | 06.5 | Days a non-payer stays `PAST_DUE` before `EXPIRED` (default `3`) |
| `AI_PROVIDER` | api | 08 | `replicate` \| `mock`. Unknown value crashes at boot (`assertAIProviderConfigured`) |
| `AI_PROVIDER_API_KEY` | api | 08 | Replicate token; **required at boot** when `AI_PROVIDER=replicate` |
| `GENERATION_TIMEOUT_MS` | api | 08 | Bound on the synchronous provider poll before failing closed (default `90000`) |
| `GENERATION_IMAGE_RETENTION_DAYS` | api | 08 | Days a completed generation stays servable before `expiresAt` (default `30`) |
| `WATERMARK_TRACE_SECRET` | api | 09 | HMAC key for the per-viewer forensic trace code; **required in every environment, min 32 chars** (boot fails otherwise) |
| `STORAGE_CLEANUP_CRON_SECRET` | api | 09 | Shared secret for `POST /api/admin/storage/cleanup/run` (timing-safe compare); mirrored as a GitHub Actions repo secret |
| `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_API_URL` | web | — | Public URLs for the web app |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | web | 10 | Default UI locale (`pt-BR` \| `en`) |
| `TRUST_PROXY` | api | 12 | Fastify `trustProxy`: unset/`false` (default), a hop count, or comma-separated proxy IPs/CIDRs. `true` is rejected at boot |
| `RECONCILIATION_CRON_SECRET` | api | 12 | Shared secret for `POST /api/admin/reconciliation/run` (timing-safe compare; required in production); mirrored as a GitHub Actions repo secret |
| `GENERATION_STALE_AFTER_MS` | api | 12 | Age at which a PENDING generation is refunded + FAILED by the sweep (default `2 × GENERATION_TIMEOUT_MS`; must exceed it) |
| `PAYOUT_STALE_AFTER_HOURS` | api | 12 | Age at which a PENDING/PROCESSING payout is flagged `payout.stale_detected` (default `72`) |
| `NEXT_PUBLIC_MEDIA_ORIGIN` | web | 12 | Storage origin signed media URLs point at; added to the web CSP `img-src`/`media-src` |
| `LOAD_TEST_FORBIDDEN_HOSTS` | load script | 12 | Comma-separated DB hosts (exact or `.suffix`) the load harness refuses to run against |

---

## Open Items / Known Issues

- No frontend auth UI yet — login/register pages arrive in a future session
- Free-tier first: all tooling choices must have a usable free tier at MVP
- Architecture must allow swapping to paid/robust tiers without a major refactor
- **Content uploads buffer the full file into memory before storage write** (Session 04) — acceptable at MVP; true streaming needs the S3 multipart upload API (deferred).
- **Locked-teaser listing deferred** (Session 04) — the list endpoint hides inaccessible gated content rather than returning it with a null thumbnail; revisit if the UI wants upsell teasers.
- **Provider request/response shapes need live verification** (Session 05) — the Woovi and NOWPayments adapters were written against published API docs and exercised only against nock-mocked HTTP, because neither merchant account is approved yet. Re-verify field names (`charge.brCode`, `charge.transactionID`, `pay_address`, `pay_amount`, the `x-webhook-signature` / `x-nowpayments-sig` schemes) against a live sandbox charge before going to production.
- **Paxum request/response shapes need live verification** (Session 06) — the `PaxumAdapter` was written against Paxum's publicly documented mass-payout *mechanics* (Paxum-to-Paxum P2P by recipient email, batch submit, asynchronous IPN confirmation, major-unit decimal amounts) and exercised only against nock-mocked HTTP, because the Business account is not approved yet. **These are provisional, not confirmed fact:** the `POST /v1/mass-payouts` path, the `x-api-key` auth header, the request keys (`payments[].correlationId` / `recipientEmail` / `amount` / `currency`, `callbackUrl`), the response keys (`batchId`, `payments[].transactionId` / `status` / `errorMessage`), the `x-paxum-signature` header, and the HMAC-SHA256-hex-over-raw-body IPN scheme. Re-verify every one against a live sandbox batch before production. All of it is confined to `paxum.adapter.ts` behind `IPayoutProvider`.
- **Payout earnings are summed in minor units without FX conversion** (Session 06) — the balance query sums `modelShareCents` across currencies, and a claim whose rows disagree falls back to `PAYOUT_CURRENCY`. Harmless while PIX/BRL dominates; a model earning in both BRL (PIX) and USD (crypto) needs per-currency payouts and an FX policy. **Still open after Session 11** (deliberately not touched — the admin metrics report per currency and never sum across them, so the gap is visible rather than hidden). Out of Session 12's scope (needs an FX-policy product decision) — **moved to Session 12.5**.
- **Credit-pack revenue is still not shared with models** (Session 06, by design) — `GenerationJob.modelId` now exists (Session 08), so the prerequisite for attributing credit spend to a model is in place, but the payout run itself still only sums `PaymentTransaction.modelShareCents` and has no path from a `GenerationJob` to a model's balance. Out of Session 12's scope (needs a product decision on the model's share of a credit spend) — **moved to Session 12.5**.
- **`ReplicateAdapter` wire shapes need live verification** (Session 08) — written against Replicate's publicly documented predictions API and the `tencentarc/photomaker` model page, exercised only against `nock`-mocked HTTP because no Replicate account is approved yet. Re-verify the pinned version hash, input field names, auth header, and the polling/cancellation contract against a live prediction before production — same treatment as the Session 05/06 payment/payout providers.
- **Stale payouts are flagged, not auto-resolved** (Session 06 → Session 12) — a `PENDING`/`PROCESSING` payout whose IPN never arrives is now **detected**: the reconciliation sweep writes one `payout.stale_detected` audit row per payout per UTC day past `PAYOUT_STALE_AFTER_HOURS`, and `GET /api/admin/metrics/overview` reports `payouts.stalePayouts`. Its status is never changed, because Paxum's status-query API is unverified and guessing a transfer's outcome is not acceptable — a human resolves it. Automatic resolution (re-querying Paxum) is the follow-up once the Business account and its API are live.
- **`Report.DISMISSED` has no write path** (Session 11) — the enum value and the `?status=dismissed` filter exist, but every resolution lands on `RESOLVED` (with `resolvedAction: 'none'` for "no action"), per the spec. A dedicated dismiss endpoint is a small follow-up if the moderation queue wants the distinction.
- **Models existing before Session 11 are `PENDING`** — the migration's default puts every already-registered model into the approval queue, so on a live database they cannot upload or take new subscribers until an admin approves them (existing `Subscription`/`ContentAccess` rows are untouched; only *new* charges and uploads are gated). Intended, but worth a pass through `/admin/models` right after deploying.
- **The admin console has no login page of its own** (Session 11) — there is still no frontend auth UI (an existing Open Item); an admin signs in via `POST /api/auth/login` (cookie) and then opens `/admin`. `AdminGate` redirects anyone without an admin session to `/`.
- **Pix Automático is a future upgrade, not a blocker** (Session 06.5) — Woovi supports Pix Automático, BACEN's recurring-mandate scheme, which would let a PIX subscription be pulled automatically instead of re-charged and re-paid each period. It is a separate, larger retrofit (mandate registration and its own consent/cancellation lifecycle, PIX-only, no crypto equivalent), so Session 06.5 deliberately shipped manual renewal that works identically on both rails. Revisit once PIX renewal volume makes the drop-off from manual payment measurable — candidate alongside Session 11/12.
- **Renewal charges accumulate as `PENDING` rows when never paid** (Session 06.5) — an unpaid renewal charge stays `PENDING` forever, and that is exactly what keeps the sweep idempotent (it is the "already charged" marker). Harmless at MVP, but there is no expiry sweep, so a long-churned subscriber leaves one stale row per model. **Still open** — not part of the Session 12 reconciliation spec (which covers generations and payouts only); a later pass of that sweep is the natural home.
- **Content published after a subscription starts is not auto-granted** (Session 05) — `ContentAccess` rows are written at confirmation time for the model's then-published catalogue. New uploads mid-period need either a grant-on-publish hook or a subscription-aware check in `resolveAccess`. Revisit when upload cadence matters.
- **Woovi adult content policy** — Woovi/OpenPix é um gateway PIX brasileiro regulado. Antes de ir ao ar em produção com conteúdo explícito adulto, confirmar com o suporte deles (suporte@woovi.com) se aceitam plataformas adult 18+. PIX em si não tem restrição de conteúdo (é infraestrutura do Banco Central), mas o gateway pode ter política própria.
- **CCBill deferred to post-MVP** — $1,450/yr Visa+MC registration fees make card processing financially unviable at MVP stage. CCBill slot is scaffolded as `MockPaymentProvider`. Activate when monthly revenue covers the annual fee.
- **NOWPayments crypto-to-fiat conversion** — NOWPayments settles in cryptocurrency. To receive BRL/USD fiat, platform must maintain exchange accounts (Bybit/OKX/Binance) and execute regular USDT→fiat withdrawals. This is an operational step outside the codebase.
- **Lei FELCA compliance (Brazil) — DEFERRED, accepted risk** — Lei 15.211/2025 requires adult platforms to implement CPF + Face ID age verification. Penalties: up to R$50M or 10% of annual Brazil revenue; full ANPD enforcement begins January 2027. **Deliberately deferred past Session 09** (business decision, 2026-09-14) to prioritize time-to-MVP — the platform runs non-compliant with the self-declaration ban until Session 09.5 ships. Note: bare CPF validation does not satisfy the law on its own (ANPD's draft guide equates it to self-declaration without proof of ownership) — the eventual fix needs a real biometric face-match, not just a CPF lookup. Must resume before meaningful Brazilian subscriber volume. ANPD is the enforcement authority.
- **One `AuditLog` row per image/video serve** (Session 09) — the trace trail grows with view volume, not with money events. Harmless at MVP; a retention policy for `content.served` / `generation.image_served` rows (e.g. 12 months) belongs in the same reconciliation/cleanup job family. **Still open** (not in the Session 12 spec).
- **`ProtectedMedia` is not wired into a real viewer yet** (Session 09) — there is no content-viewing page; the component is exercised only by the `/dev/protected-media` demo (placeholders, 404 in prod) and its tests. The future subscriber UI must wrap every `<img>`/`<video>` served from `/serve` or `/generations/:id/image` in it and pass the `traceCode` (video: from the JSON; image: a future header or the code is simply already burned in).
- **The trace code is per-minute, so a code names a viewer, not a single request** (Session 09, by design) — two serves by the same viewer of the same item within one minute share a code and both audit rows; the lookup returns both, which is the intended de-duplication, but an investigation should read *all* rows for a code, not the first.
- **`turbo run lint` runs nothing** (pre-existing, noted in Session 09) — no package defines a `lint` script; the real gate is root `pnpm lint` (`eslint .`), which CI runs. `pnpm format:check` also flags several pre-existing files; only Session 09's own files were formatted, on purpose.
- **Paxum → Woovi/NOWPayments wire** — model payouts via Paxum require the platform to accumulate earnings from Woovi and NOWPayments, then fund the Paxum business account. Still a manual treasury step outside the codebase (Session 06 automates the *distribution*, not the *funding*); document the SOP before the first live run.
- **MEI faturamento limit** — MEI CNPJ 67.735.318/0001-91 has R$130k/year revenue cap. When platform revenue approaches this threshold, migrate to ME (Microempresa) with a contador. This unlocks higher volume and formal payroll if needed.
- **Telegram Stars** — optional secondary channel for microtransactions on Telegram bots. ~32% effective fee on mobile purchases. 21-day withdrawal hold. iOS restrictions on adult content via Stars. Not a primary payment channel — integrate only if there is an active Telegram community.
- **Messaging fan-out is process-local, not horizontally scalable** (Session 07) — `connections.ts` holds an in-memory `Map<userId, Set<socket>>`. A recipient connected to a different API instance never receives the live push (they still see the message on next history fetch — nothing is lost, just not real-time across instances). Needs a shared pub/sub (Redis or similar) before running more than one API instance. **Moved to Session 13** (deployment), together with the rate-limit store below.
- **`npx prisma` must be run from `apps/api`, not the repo root** (Session 07 tooling note) — in this pnpm workspace, `prisma` is a devDependency of `@creator-platform/api` only. Running a bare `npx prisma migrate deploy` from the monorepo root can resolve an unrelated package instead of the pinned local CLI, producing confusing errors with no resemblance to Prisma's actual command set. Always `cd apps/api` first, or use `pnpm --filter @creator-platform/api exec prisma <command>`.
- **Web and API must share one registrable domain — a custom domain is required** (Session 12 addendum, for Session 13) — serve them as e.g. `app.<domain>` / `api.<domain>`. Two things break across sites: the API sends `Cross-Origin-Resource-Policy: same-site` (so the web origin could not load the watermarked image streams), and the auth cookies are `SameSite=Strict` (so the browser would not send them on the web app's credentialed API calls). Platform default subdomains (`*.up.railway.app`, `*.onrender.com`, `*.fly.dev`) are on the Public Suffix List, so `web.x.up.railway.app` and `api.x.up.railway.app` count as **different sites**. The custom domain is therefore a requirement, not optional.
- **Generation success path is not a compare-and-set** (Session 12 addendum, low priority, not fixed) — `generation.service.ts` completes a job with an unconditional `prisma.generationJob.update({ where: { id } })`. It should be an `updateMany({ where: { id, status: 'PENDING' } })` CAS, so a job the reconciliation sweep has already FAILED and refunded can never flip to COMPLETED if a provider call hangs past `GENERATION_STALE_AFTER_MS`. Today only the boot-time rule `GENERATION_STALE_AFTER_MS > GENERATION_TIMEOUT_MS` prevents it (the request's own budget normally ends first).
- **Rate-limit counters are in-memory, per process** (Session 12 audit, A07) — `@fastify/rate-limit` uses its default local store, so every budget is per API instance; two instances double every limit. Correct for the single-instance MVP. A Redis-backed store is **scheduled for Session 13**, alongside messaging pub/sub.
- **Register answers 409 for an existing email** (Session 12, accepted risk, A07) — reveals that an address has an account; mitigated by the 5/IP/hour limit (per real client once `TRUST_PROXY` is set). Future fix: a uniform 201 either way plus an "account already exists" email to the owner.
- **`JWT_SECRET` / `JWT_REFRESH_SECRET` length is not enforced at boot** (Session 12 audit, A02) — `env.ts` uses `required`, not `requiredMinLength`; `.env.example` asks for ≥32 chars. Switch both to `requiredMinLength(…, 32)`.
- **Replicate output download has no host allowlist** (Session 12 audit, A10) — `replicate.adapter.ts` fetches whatever output URL the prediction names (no credentials are sent on that request). Pin it to Replicate's delivery host when the adapter is verified against a live account.
- **Content list loads a model's whole catalogue, with an N+1 access check** (Session 12 index review, F1) — `listModelContent` has no `take` and runs one `contentAccess.findUnique` per gated row before paginating in memory. Fine at MVP catalogue sizes; see `docs/performance/index-review.md` for the fix.
- **Load baseline has only the dry run** (Session 12, D8) — `docs/performance/load-baseline.md` measures `GET /health` only. The DB-backed scenarios need a non-production database; run `pnpm --filter @creator-platform/api load` against one (the only configured DB is the shared Supabase project, deliberately not load-tested).
- **Web CSP allows `'unsafe-inline'` styles** (Session 12, A03) — required by React `style={…}` attributes; scripts are nonce-only. Moving to class-based styles would allow tightening it.
- **`Subscription_status_idx` is probably redundant** (Session 12 index review) — it is the leading column of the composite renewal-sweep index. Not dropped (the spec only allowed dropping duplicates of a *unique* constraint's leading column); revisit with real query plans.
- **`apps/web/next-env.d.ts` is rewritten by every Next 16 build** (Session 12.6) — Next 16 writes `import "./<distDir>/types/…"` lines with no opt-out, so the SSR test's `.next-test` build leaves the tracked file locally modified. Harmless; untracking it (Next's recommendation) is the clean follow-up.
- **First Load JS grew ~45% with Next 16 / React 19** (Session 12.6, informational) — `/` 100.5 → 146.6 kB, `/wallet` 103.0 → 148.7 kB gzip, with no page code changed (framework-side growth; not broken down per chunk). Revisit if page-weight budgets are introduced.

---

## Last Updated — Session 12.6 fastify hotfix + CLAUDE.md split. `fastify` bumped to `^5.12.5` (`f21f40e`), closing the X-Forwarded-For spoofing advisory ahead of setting `TRUST_PROXY`. CLAUDE.md restructured into an index plus Engineering Invariants, with session history, Architecture Decisions, resolved Open Items and earlier Last Updated entries moved verbatim to `docs/` (no content lost — 872/872 original lines verified). **Next: Session 13 (MVP Deployment).** [2026-09-28]
