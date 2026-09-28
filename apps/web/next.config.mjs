import createNextIntlPlugin from 'next-intl/plugin';

/**
 * next-intl (Session 10): wires `src/i18n/request.ts` as the per-request
 * locale/messages source for server components. Cookie-only locale routing —
 * no `/en/` prefix — so no `i18n.locales` block, and the only middleware
 * (Session 12's CSP nonce) never touches the locale.
 */
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Static security headers for every route (Session 12, D5). The
 * Content-Security-Policy is NOT here: it carries a per-request nonce, so
 * `src/middleware.ts` sets it. HSTS only for a production build/server — a
 * development server on http://localhost must never pin HTTPS in a browser.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-Frame-Options', value: 'DENY' },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

/**
 * Next.js config.
 * `transpilePackages` lets Next compile the workspace `shared` package straight
 * from its TypeScript source (no separate build step needed in the monorepo).
 *
 * `distDir` is overridable by `NEXT_DIST_DIR` for one reason: the Session 10
 * SSR test builds and starts a real Next server, and Turborepo may run that
 * test in parallel with `next build` for the same package — two builds writing
 * the same `.next/` would corrupt each other. Unset (every non-test path) it
 * is the default `.next`.
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@creator-platform/shared'],
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
