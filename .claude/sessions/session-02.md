# Session 02 — Auth

## Context Recap (from [CLAUDE.md](http://CLAUDE.md))

* Monorepo: pnpm workspaces + Turborepo, TypeScript strict throughout

* Backend: Fastify (`apps/api`) — entry at `src/index.ts`, Prisma + Supabase Postgres

* Frontend: Next.js 14 App Router (`apps/web`)

* Shared types: `@creator-platform/shared` (`packages/shared/src/index.ts`)

* Auth strategy defined: JWT access token (15m) + refresh token (7d), httpOnly cookies, RBAC roles: `admin | model | subscriber`

* Email: Resend (transactional, free tier)

* No auth code exists yet — this session implements it from scratch

---

## Objective

Implement a complete, production-grade authentication system for the platform:\
registration with email verification, login with JWT + refresh token rotation,\
logout, token refresh endpoint, and RBAC middleware for protecting routes.

---

## Deliverables & Acceptance Criteria

### 1\. Prisma Schema — User model

* Add `User` model to `apps/api/prisma/schema.prisma`:

  ```
  id                   String    @id @default(cuid())
  email                String    @unique
  passwordHash         String
  role                 Role      @default(SUBSCRIBER)
  displayName          String
  isVerified           Boolean   @default(false)
  verifyToken          String?   @unique
  verifyTokenExpiresAt DateTime?
  refreshTokenHash     String?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
  ```

* Add `enum Role { ADMIN MODEL SUBSCRIBER }`

* Run `prisma migrate dev --name add-user-model` — migration file must exist at `apps/api/prisma/migrations/`

* Run `prisma generate` — client available at `apps/api/prisma/generated/`

### 2\. POST /api/auth/register

* Accepts: `{ email, password, displayName, role: "model" | "subscriber" }`

* `role` field must only accept `model` or `subscriber` — reject `admin` with 400

* Password: min 8 chars, validated before hashing

* Hash password with **bcrypt, cost factor 12**

* Generate email verification token: `crypto.randomBytes(32).toString('hex')`

* Token expires in 24h

* Save user with `isVerified: false`, store token + expiry

* Send verification email via **Resend** with a link: `${APP_URL}/verify-email?token=<token>`

* Returns: `201 { userId, role, message: "Verification email sent" }` — **no token issued yet**

* Rate limit: **max 5 requests / IP / hour**

* Integration test: full register → check DB → verify email not sent if duplicate

### 3\. GET /api/auth/verify-email?token=<token>

* Find user by `verifyToken`, check not expired

* Set `isVerified: true`, clear `verifyToken` and `verifyTokenExpiresAt`

* Returns: `200 { message: "Email verified" }`

* Returns 400 if token invalid or expired

### 4\. POST /api/auth/login

* Accepts: `{ email, password }`

* Reject unverified users with `403 { error: "Email not verified" }`

* Compare password with bcrypt

* On success:

  * Generate **access token** (JWT, 15m, signed with `JWT_SECRET`)

  * Generate **refresh token** (JWT, 7d, signed with `JWT_REFRESH_SECRET`)

  * Hash refresh token with bcrypt (cost 10) and store hash in DB

  * Set **access token in httpOnly cookie** (`access_token`, Secure, SameSite=Strict, maxAge=15min)

  * Set **refresh token in httpOnly cookie** (`refresh_token`, Secure, SameSite=Strict, maxAge=7d)

  * Returns: `200 { userId, role, displayName }` — **no tokens in response body**

* Rate limit: **max 10 requests / IP / 15 min**

* Integration test: register → verify → login → assert cookies set

### 5\. POST /api/auth/refresh

* Read `refresh_token` from httpOnly cookie

* Verify JWT signature with `JWT_REFRESH_SECRET`

* Find user, compare token with stored hash (bcrypt compare)

* Rotate: generate new access + refresh tokens, update hash in DB

* Set new cookies (same flags)

* Returns: `200 { message: "Token refreshed" }`

* Invalidate old refresh token (hash replaced — old token unusable)

* Returns 401 if token missing, invalid, or not matching DB

### 6\. POST /api/auth/logout

* Clear both httpOnly cookies (set maxAge=0)

* Set `refreshTokenHash = null` in DB for the user

* Returns: `200 { message: "Logged out" }`

* Requires valid access token (authenticated route)

### 7\. GET /api/auth/me

* Protected route — requires valid access token cookie

* Returns: `200 { userId, email, role, displayName, isVerified }`

* Returns 401 if no/invalid token

### 8\. RBAC Middleware

* Create Fastify preHandler hook: `authenticate` — verifies access token cookie, attaches `req.user = { userId, role }`

* Create `authorize(...roles: Role[])` — checks `req.user.role` against allowed roles, returns 403 if unauthorized

* Export both from `apps/api/src/middleware/auth.ts`

* Apply `authenticate` to `/api/auth/logout` and `/api/auth/me`

* Write unit tests for both middleware functions

### 9\. Shared types

* Add to `packages/shared/src/index.ts`:

  ```ts
  export type Role = 'admin' | 'model' | 'subscriber'
  export interface JwtPayload { userId: string; role: Role; }
  export interface AuthUser { userId: string; email: string; role: Role; displayName: string; }
  ```

### 10\. Environment variables

Ensure these are added to `apps/api/.env.example` (with placeholder values):

```
JWT_SECRET=your-jwt-secret-min-32-chars
JWT_REFRESH_SECRET=your-jwt-refresh-secret-min-32-chars
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
EMAIL_API_KEY=re_xxxxxxxxxxxx
EMAIL_FROM=noreply@yourdomain.com
APP_URL=http://localhost:3000
```

---

## Security Requirements

* **No tokens in response body or localStorage** — httpOnly cookies only

* **No hardcoded secrets** — all from env vars, validated at startup (throw if missing)

* **Bcrypt cost 12** for passwords, cost 10 for refresh token hash

* **Rate limiting** on register (5/IP/h) and login (10/IP/15min) — use `@fastify/rate-limit`

* **Input validation** on all endpoints — use Zod or JSON schema via `@fastify/type-provider-typebox`

* **CORS** configured to allow only `APP_URL` origin, credentials: true

* **Cookie flags**: `httpOnly: true`, `secure: true` (in production), `sameSite: 'strict'`

* Refresh token stored as **hash only** — plain text never persisted

* Email verification token stored as plain text (one-time use random token, not a secret key)

* Startup validation: if `JWT_SECRET`, `JWT_REFRESH_SECRET`, or `EMAIL_API_KEY` are missing → throw and exit

---

## Performance Requirements

* Login endpoint p99 < 500ms (bcrypt is the bottleneck — cost 12 is acceptable)

* No N+1 queries — all DB lookups by indexed fields (`email`, `verifyToken`)

* Ensure `email` and `verifyToken` have DB indexes (Prisma adds `@unique` index automatically)

---

## Tech Choices Guidance

* Use **`@fastify/jwt`** for JWT signing/verification — fits Fastify's plugin system natively

* Use **`@fastify/cookie`** for cookie read/write

* Use **`@fastify/rate-limit`** for rate limiting

* Use **`bcryptjs`** (pure JS, no native build issues) over `bcrypt`

* Use **Resend SDK** (`resend` npm package) for transactional email

* Use **Zod** for input validation — integrate via manual validation in route handlers or a Zod-to-JSON-schema bridge

* Briefly justify any deviation from these suggestions in a comment at the top of the relevant file

---

## File Structure Expected After Session

```
apps/api/src/
├── index.ts                  (updated: register plugins, CORS, cookies, rate-limit)
├── middleware/
│   └── auth.ts               (authenticate + authorize)
├── modules/
│   └── auth/
│       ├── auth.routes.ts    (register all auth routes)
│       ├── auth.service.ts   (business logic: register, login, refresh, logout)
│       ├── auth.schema.ts    (Zod/JSON schemas for request validation)
│       └── auth.test.ts      (integration + unit tests)
apps/api/prisma/
├── schema.prisma             (updated with User + Role)
└── migrations/               (new migration folder with add-user-model)
packages/shared/src/
└── index.ts                  (updated with Role, JwtPayload, AuthUser types)
```

---

## Definition of Done

* \[ \] `User` model + `Role` enum in Prisma schema, migration applied

* \[ \] POST /api/auth/register — bcrypt hash, email verification token, Resend email, rate limited

* \[ \] GET /api/auth/verify-email — token validation + user activation

* \[ \] POST /api/auth/login — bcrypt compare, JWT in httpOnly cookies, rate limited

* \[ \] POST /api/auth/refresh — token rotation, old hash invalidated

* \[ \] POST /api/auth/logout — cookies cleared, DB hash nulled

* \[ \] GET /api/auth/me — authenticated, returns user info

* \[ \] `authenticate` + `authorize` middleware exported and tested

* \[ \] Shared types (`Role`, `JwtPayload`, `AuthUser`) in `@creator-platform/shared`

* \[ \] All env vars documented in `apps/api/.env.example`

* \[ \] Startup crashes with clear error if required secrets are missing

* \[ \] No tokens in response bodies

* \[ \] No hardcoded secrets anywhere

* \[ \] Rate limiting active on register + login

* \[ \] `pnpm turbo run typecheck test` passes with no errors

* \[ \] ARIA validation passed before commit