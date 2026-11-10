# Session 13.1 — Hotfix: Production Dependency Advisories (CI Audit Red)

## Context Recap (from CLAUDE.md)

- Session 13 is complete. Production runs release `471cefc` on the
  DigitalOcean droplet (Caddy → api + web), deployed by the manual `Deploy`
  workflow with a pinned `sha`.
- Green means `pnpm turbo run typecheck test build`, root `pnpm lint`, and
  `pnpm audit --prod --audit-level=high` **with no ignore list** (Engineering
  Invariants → Testing & tooling).
- JWTs are httpOnly cookies, pinned to HS256 on sign and verify, through
  `@fastify/jwt` (Session 02 / Session 12).
- Web is Next.js 16.x + React 19 (Session 12.6), with a per-request CSP nonce in
  `apps/web/src/proxy.ts` and `/_next/image` closed.
- The precedent is Session 12.6's fastify hotfix (`f21f40e`): bump to a patched
  release, with no exceptions.

## Objective

The CI run `42730500701` on `main` (`d4707f6`, docs-only commits) failed
**only** in the `Audit` job. New advisories published after the last green run
put **28 vulnerabilities (6 low, 13 moderate, 6 high, 3 critical)** in the
production dependency tree. The same versions are in the release running in
production.

Upgrade every production dependency with a **high or critical** advisory to a
patched version, so that the `Audit` job goes green again with no ignore list.
Do not change behaviour.

## Known advisories (from the CI log excerpt — incomplete)

| Severity | Package | Advisory | Path | Patched |
|---|---|---|---|---|
| high | `fast-jwt` | GHSA-5hjw-83fp-phq9 — silent claim-validator bypass when the JWT payload is a JSON array | `apps/api > @fastify/jwt > fast-jwt` | `>=6.3.0` |
| high | `fast-jwt` | GHSA-g3jj-5cmm-3hxx — raw public JWK JSON treated as an HMAC secret (HS256 forgery) | `apps/api > @fastify/jwt > fast-jwt` | `>=6.3.0` |
| high | `next` | GHSA-p3m5-59mp-jv5r — DoS in App Router via Server Actions | `apps/web > next` | `>=16.4.1` |
| high | `zod` | GHSA-mrhx-c7xc-m3w5 — memory exhaustion on oversized constrained collections | `apps/api > zod` | `>=4.6.6` |
| critical ×3, high ×2 | **unknown** — not in the excerpt | — | — | — |

## Deliverables & Acceptance Criteria

### D1 — Full inventory first
- Run `pnpm audit --prod` and record **every** high and critical advisory
  (package, GHSA id, path, patched range) in a table in the session notes,
  **before** changing anything.
- Acceptance: the table lists all 9 high/critical findings (6 high + 3
  critical), or explains any discrepancy with the CI count.

### D2 — Upgrade via direct dependencies
- Prefer bumping the **direct** dependency to a release that pulls the
  patched transitive version: `@fastify/jwt` (for `fast-jwt >=6.3.0`), `next`
  (`>=16.4.1`, stay on 16.x), `zod` (`>=4.6.6`, stay on 4.x), and whatever the
  inventory shows for the criticals.
- Use `pnpm.overrides` **only** when no patched parent release exists. Every
  override must carry a comment with the GHSA id, the reason, and the condition
  for removing it. **No `pnpm audit` ignore entries** (`auditConfig.ignoreCves`
  / `ignoreGhsas` are forbidden by the invariant).
- Commit the lockfile.
- Justify each upgrade choice in one line.

### D3 — Behaviour preserved
- **Auth:** HS256 stays pinned on sign and verify. Add a regression test: a
  token whose payload is a JSON array (correctly HS256-signed with the test
  secret) is **rejected** by `authenticate` with 401. Add another: a token
  signed with any algorithm other than HS256 is rejected. All existing auth
  tests pass.
- **Web:** `pnpm --filter @creator-platform/web build` passes. `proxy.ts` CSP
  nonce behaviour is unchanged (existing `csp.test.ts` passes).
  `images.unoptimized` stays set, and `/_next/image` stays closed. Report the
  First Load JS of `/` and `/wallet` before and after.
- **Zod:** every schema test passes, with no changed error codes or response
  shapes.
- Run the full suite unchanged: `pnpm turbo run typecheck test build`, root
  `pnpm lint`.

### D4 — Audit green
- `pnpm audit --prod --audit-level=high` exits **0**.
- List the moderate/low findings that remain, with packages and paths, in
  CLAUDE.md Open Items. Fixing them is not required here.

### D5 — Docs
- CLAUDE.md: add a Session Map row `13.1 | Hotfix: dependency advisories |
  ✅ Complete`, and a Last Updated entry (the previous entry moves to
  `docs/history/last-updated.md`).
- `docs/history/resolved-items.md`: one entry listing the GHSA ids and the
  versions that fixed them.
- `docs/history/sessions.md`: a Session 13.1 entry.

## Security Requirements
- Do not weaken JWT verification options (`algorithms: ['HS256']`, claim
  checks) to make an upgrade compile.
- No new runtime dependency unless a patched release requires it.
- No secrets in tests or fixtures (generate them in-test).

## Performance Requirements
- No regression in the existing tests' timing envelope.
- Report a First Load JS change above +5 % per route; it is not a blocker.

## Tech Choices Guidance
- Stay within the current majors (Next 16, React 19, Fastify 5, Zod 4).
- If a critical advisory has no patched release at all, **stop** and report:
  the package, the GHSA id, whether the vulnerable code path is reachable in
  this app (with file/line evidence), and options. Do not add an ignore entry.

## Deployment note (owner, after merge — not Claude Code)
- CI green on the merge commit → `/health/ready` = 200 → `gh workflow run
  deploy.yml --ref main -f sha="$(git rev-parse origin/main)"` (runbook §5,
  deviation 17).
- Expect smoke 16/18 (the 2 known false FAILs, deviation 15). Re-check `vf ps`,
  `docker stats`, browser admin login, and one `wallet/balance` call.

## Definition of Done
- [ ] D1 inventory table (all high/critical, with GHSA ids)
- [ ] D2 upgrades via direct deps; overrides only if unavoidable, each documented; lockfile committed
- [ ] D3 new JWT regression tests (array payload, non-HS256) pass; all existing tests pass; web build + CSP tests pass
- [ ] `pnpm audit --prod --audit-level=high` exits 0 with no ignore list
- [ ] `pnpm turbo run typecheck test build` + `pnpm lint` green
- [ ] No hardcoded secrets
- [ ] CLAUDE.md, resolved-items.md and sessions.md updated
- [ ] ARIA validation passed
