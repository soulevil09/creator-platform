/**
 * Next.js config.
 * `transpilePackages` lets Next compile the workspace `shared` package straight
 * from its TypeScript source (no separate build step needed in the monorepo).
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@creator-platform/shared'],
};

export default nextConfig;
