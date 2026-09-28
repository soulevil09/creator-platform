# Session 12.6 — Framework Upgrade: Next.js 16.3 (Active LTS) + React 19

## Context Recap (from CLAUDE.md)

- Session 12 is complete and pushed (`2ef9dd8` feat, `e33bc63` fix(ci), `5983872` docs). Current totals are 416 API / 48 web / 6 shared tests. CI has five jobs: lint, typecheck, test, build and audit.
- `apps/web` runs **Next 14.2.35 + React 18.3**. The Session 12 audit gate passes only because root `package.json` `pnpm.auditConfig` excepts **12 advisories by id** (8 `ignoreCves`, 4 `ignoreGhsas`). All of them are in `next@14` or the `postcss@8.4.31` it pins exactly. The most serious is **GHSA-2xp9-vwfh-vxw4**, an unauthenticated RCE in the Image Optimization API (`/_next/image`), which CLAUDE.md marks as a **🚫 BLOCKER for Session 13**.
- Next.js' August 2026 security release patched only **16.3.x (Active LTS)** and **15.5.x (Maintenance LTS)**. Next 14 received no patch. This session targets **16.3**, not 15.5: moving to 15 now would mean repeating this migration within months.
- The web app is small: about 23 source files. The Next-specific surface is `src/middleware.ts` (per-request CSP nonce, Session 12), `src/i18n/request.ts` (next-intl `getRequestConfig`, where `cookies()`/`headers()` are **already awaited**), `next.config.mjs` (next-intl plugin, static security headers, `NEXT_DIST_DIR`), and the real-server test `src/i18n/ssr.test.ts`, which runs `next build` + `next start` and asserts locale, the nonce CSP and the static headers.
- Root `package.json` declares `"engines": { "node": ">=20" }` and every CI job uses Node 20. Node 20 reached end of life in April 2026. The development machine runs Node 22.

**Out of scope for this session:**
- Any API (`apps/api`) change. Exception: if the lockfile resolution forces a shared devDependency bump, that is allowed, but no source change.
- Any new feature, page, UI string or visual change. Any change to CSP *policy content* (directives and sources stay exactly as Session 12 defined them). Any change to locale resolution behavior.
- Deployment work (Session 13), FX/credit-spend sharing (Session 12.5), Lei FELCA (09.5).
- Adopting new Next 16 features (Cache Components, `use cache`, React Compiler, View Transitions, etc.). This is a like-for-like upgrade.

---

## Objective

Move `apps/web` to the latest **Next.js 16.3.x** patch and **React 19**. The app's observable behavior must stay identical: same pages, same locale resolution, same CSP with a per-request nonce, same static headers, and the same test suite passing with no weakened assertions. Every Next/postcss audit exception is removed, and CI moves to a supported Node LTS.

---

## Deliverables & Acceptance Criteria

### D0 — Precondition

- Before any change, run `pnpm install --frozen-lockfile` and `pnpm turbo run typecheck test build` at the repo root. Record the totals: 416 / 48 / 6 expected. If either command fails, **stop and report**. Do not start the upgrade on a red baseline.

### D1 — Dependency upgrade

- `apps/web`:
  - `next` → the **latest published 16.3.x patch**. It must be ≥ the version that fixes GHSA-2xp9-vwfh-vxw4 (16.3.3 per the August 2026 release; use the newest 16.3.x available). Check with `pnpm view next versions`, and state the exact version in the summary.
  - `react` / `react-dom` → the React 19 version that Next 16.3 declares as its peer (use the latest 19.x satisfying it).
  - `@types/react` / `@types/react-dom` → matching 19.x.
  - `next-intl` → the latest 4.x that declares Next 16 + React 19 as supported peers. If no 4.x does, **stop and report** instead of forcing or upgrading to a new major.
  - `@testing-library/react`, `@testing-library/dom`, `jsdom` → bump only if needed for React 19 compatibility, within their current major if possible. Any major bump must be justified in one line.
- Run `pnpm install` so the lockfile reflects the new graph, then confirm `pnpm install --frozen-lockfile` passes on the result.
- **No peer-dependency warnings are silenced** (no `strict-peer-dependencies=false`, no `peerDependencyRules.ignoreMissing` / `allowAny` added). If a peer warning remains, report it with its source.
- **Acceptance:** `pnpm why next react react-dom` shows exactly one version of each in the web app's graph, and it is the target version.

### D2 — Code migration (like-for-like)

- **`middleware.ts` → `proxy.ts`.** Next 16 renamed the Middleware convention to Proxy. Rename the file to `apps/web/src/proxy.ts` and the exported function to `proxy`, keeping `config.matcher` and all logic byte-for-byte equivalent (`createNonce`, `buildContentSecurityPolicy`, `x-nonce` + CSP on the forwarded request, CSP on the response). Update its header comment (Next 16 Proxy pattern) and every reference to `middleware.ts` in comments, `next.config.mjs`, CLAUDE.md and `docs/security/owasp-audit.md`.
  - If the proxy's runtime (Node.js in Next 16) makes `createNonce()` behave differently, fix it in `csp.ts` with the Web Crypto API (`crypto.getRandomValues` → base64). It must stay 128 bits, and the existing `createNonce` unit test must pass unchanged.
- **Async request APIs.** Next 16 removes synchronous access to `cookies()`, `headers()`, `draftMode()`, `params`, and `searchParams`. Audit every file: `request.ts` is already compliant. Fix any other usage (e.g. pages reading `searchParams`) by awaiting it, with no behavior change.
- **`next.config.mjs`:**
  - Remove any option Next 16 no longer accepts (e.g. an `eslint` key, `experimental` flags that were removed or renamed). Keep `transpilePackages`, the `NEXT_DIST_DIR` override, `headers()`, and the next-intl plugin.
  - The build must succeed under Next 16's default bundler (Turbopack). If the next-intl plugin or `transpilePackages` of the workspace `shared` package fails under Turbopack, **first** try the documented next-intl/Turbopack configuration. Only if that fails, fall back to `next build --webpack`. That fallback is a deviation and must be flagged with the exact error.
- **React 19 type changes.** Fix any type errors from `@types/react@19` (e.g. `JSX` namespace moved under `React.JSX`, `useRef` requiring an argument, `ReactElement` props typed as `unknown`) with the smallest correct change. **No `any`, no `@ts-expect-error`, no `// eslint-disable`** introduced to get past them.
- **`next-env.d.ts`** is regenerated by the build. Keep it untracked or tracked exactly as it is today.
- **Acceptance:** `pnpm --filter @creator-platform/web typecheck` and `build` pass. `git grep -n "middleware" apps/web` returns only historical mentions in comments that explicitly say "renamed to proxy in Session 12.6", or nothing.

### D3 — Image Optimization endpoint closed (defense in depth)

The app renders no `next/image`, yet `next start` still serves `/_next/image`. Patching Next fixes the known RCE. Closing an endpoint the app never uses removes the attack surface for the next one.

- Make `/_next/image` answer a **4xx** on the production server. Prefer configuration (e.g. `images: { unoptimized: true }` if in Next 16.3 it stops the optimizer from serving, or an explicit route-level block). Verify the behavior empirically; do not assume it from documentation.
- If only a proxy-level block works, add `/_next/image` handling to `proxy.ts` (it is excluded from the current matcher, so adjust the matcher deliberately). Return 404 with no body before any optimizer code runs, and explain the choice in one line.
- **Acceptance:** a new test in `ssr.test.ts` against the real `next start` server shows `GET /_next/image?url=%2Ffavicon.ico&w=64&q=75` returning a 4xx and **not** an `image/*` content type.

### D4 — Audit exceptions removed

- Delete **all 12** Next/postcss entries from root `package.json` `pnpm.auditConfig` (`ignoreCves` and `ignoreGhsas`). If both lists end up empty, remove the `auditConfig` block entirely.
- Run `pnpm audit --prod --audit-level=high`.
  - If a high/critical advisory remains in `postcss` (still pinned by Next 16), resolve it with a `pnpm.overrides` entry to the patched **same-major** `postcss` 8.x. Justify it in one line and prove `next build` still passes.
  - Any other remaining high/critical advisory: fix it in-range. If it truly cannot be fixed, add a scoped exception by id with the reason in `docs/security/owasp-audit.md` (A06), as in Session 12. Blanket ignores are not allowed.
- **Acceptance:** `pnpm audit --prod --audit-level=high` exits 0. The number of remaining exceptions is reported, and the target is **zero**. The A06 table in `docs/security/owasp-audit.md` is updated to show the Next 14 exceptions as resolved by Session 12.6.

### D5 — Node LTS in CI and `engines`

- All five jobs in `.github/workflows/ci.yml`: `node-version: 20` → `22`.
- Root `package.json` `engines.node` → `">=22"`.
- Leave the cron workflows (`weekly-payout.yml`, `subscription-renewals.yml`, `storage-cleanup.yml`, `reconciliation.yml`) unchanged unless they set up Node. They only run `curl`.
- `@types/node` in each package → the latest `22.x`, **only if** the typecheck is clean with it. Otherwise leave it and note why.
- **Acceptance:** `grep -rn "node-version" .github/workflows` shows only `22`, and the full gate passes locally on Node 22.

### D6 — Behavioral parity (the real acceptance)

- The **entire existing web suite passes with no assertion weakened, removed, or skipped**: all 48 tests, including the 5 real-server locale tests and the 3 real-server CSP/header tests. If an assertion *must* change because Next 16 changed an observable output that is not security-relevant (e.g. a different but equivalent HTML attribute order), change it minimally and list every such change with a before/after in the summary. Assertions on the nonce, CSP directives, static headers, HSTS, `<html lang>`, catalog shipping, and locale precedence **may not change at all**.
- The real-server test must still prove: (a) every `<script>` in the production HTML carries the header's nonce; (b) the nonce differs per request; (c) the CSP has `'strict-dynamic'` and no `'unsafe-eval'` in production. If Next 16 renders scripts without the nonce, that is a **stop-and-report** condition. Do not relax the CSP to compensate.
- API suite (416) and shared suite (6) unchanged and green.
- **Acceptance:** web total is ≥ 49 (48 + the D3 test); `pnpm turbo run typecheck lint test build --force` shows 9/9 tasks passing; root `pnpm lint` (incl. jsx-a11y) passes with zero findings.

---

## Security Requirements

- CSP policy content, static headers, cookie handling and the `ProtectedMedia` deterrents stay exactly as in Session 12. This session changes the framework under them, not the policy.
- `'unsafe-inline'` must never be added to `script-src`, `'unsafe-eval'` must never appear in production, and the nonce must stay per-request and 128-bit.
- No peer-dependency or audit warning may be silenced. Each remaining one is fixed or reported by id.
- The `/dev/protected-media` demo must still 404 in production. Re-verify it, since the Next 16 build pipeline changed.

## Performance Requirements

- Report `next build` wall time and the First Load JS size of `/` and `/wallet` before (Next 14) and after (Next 16), as printed by the build. The numbers are informational, not a gate. Flag any page whose First Load JS grew by more than 25%.

## Tech Choices Guidance

- **16.3 over 15.5:** 16.3 is Active LTS, and 15.5 is Maintenance LTS receiving only critical fixes, so 16.3 avoids a second migration. State this in one line in the summary.
- Follow Next's official 15→16 upgrade guide for anything not covered here. The official codemod (`npx @next/codemod@canary upgrade latest`) may be used, but review and report every change it makes. Revert anything outside this spec's scope (new features, config it adds speculatively).
- No new runtime dependencies.

---

## Definition of Done

- [ ] D0 baseline recorded (416 / 48 / 6, gate green) before any change
- [ ] `next` on the latest 16.3.x (exact version stated), React/ReactDOM 19 with matching types, next-intl 4.x compatible, one version of each in the graph
- [ ] `middleware.ts` → `proxy.ts`, behavior identical; all async request APIs compliant; React 19 type fixes without `any` / `@ts-expect-error` / eslint-disable
- [ ] `/_next/image` returns 4xx on `next start`, proven by a real-server test
- [ ] All 12 audit exceptions removed; `pnpm audit --prod --audit-level=high` exits 0; remaining exceptions reported (target: zero); A06 table updated
- [ ] CI on Node 22, `engines.node >= 22`
- [ ] Web ≥ 49 tests, API 416, shared 6, with no weakened/skipped assertions (any unavoidable non-security change listed with before/after); `pnpm turbo run typecheck lint test build --force` 9/9 and root `pnpm lint` passing
- [ ] `/dev/protected-media` still 404 in production
- [ ] Build time + First Load JS before/after reported
- [ ] CLAUDE.md updated: Session 12.6 entry (Summary / Notes & deviations / External Prerequisites: none); Tech Stack row "Next.js 14" → "Next.js 16.3 (Active LTS) + React 19"; Architecture Decisions (16.3 over 15.5; proxy.ts; `/_next/image` closed); Repository Structure (`proxy.ts`); Open Items (close the "🚫 BLOCKER — Next.js 14 audit exceptions" item; remove the Next 15 blocker from Session 13's prerequisites); Last Updated
- [ ] ARIA validation passed
