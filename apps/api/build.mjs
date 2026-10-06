// =============================================================================
// API production build (Session 13, D6).
//
// `tsc` used to emit dist/, but that output could not run: it kept bare
// imports of `@creator-platform/shared`, whose entry is TypeScript source. The
// API is now bundled with esbuild:
//
//   * first-party code AND the workspace `shared` package are inlined;
//   * every npm dependency stays external (resolved from node_modules at
//     runtime — native ones like sharp and the Prisma engines cannot be
//     bundled), as does the generated Prisma client (`#prisma-client`);
//   * two entry points: the server and the ops CLI.
//
// Typechecking stays `tsc --noEmit`. No source maps are emitted.
// =============================================================================
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

/** Bare specifiers are npm packages → external, except our own workspace code. */
const externalizeDependencies = {
  name: 'externalize-dependencies',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@creator-platform/')) return undefined; // inline
      return { path: args.path, external: true };
    });
  },
};

await rm('dist', { recursive: true, force: true });

await build({
  entryPoints: {
    index: 'src/index.ts',
    'scripts/ops/create-user': 'scripts/ops/create-user.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  plugins: [externalizeDependencies],
});
