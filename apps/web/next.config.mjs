import createNextIntlPlugin from 'next-intl/plugin';

/**
 * next-intl (Session 10): wires `src/i18n/request.ts` as the per-request
 * locale/messages source for server components. Cookie-only locale routing —
 * no `/en/` prefix — so no `i18n.locales` block and no middleware here.
 */
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

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
};

export default withNextIntl(nextConfig);
