import { defineConfig } from 'vitest/config';

// Session 09 is the first session to ship a tested React component, so this is
// the web package's first Vitest config.
//
// Why `jsdom`: `ProtectedMedia` is entirely about DOM behaviour — a prevented
// context-menu event, `document.visibilitychange`, `window` blur/focus, and
// `HTMLMediaElement.pause()`. Those have no meaning in the `node` environment
// the API suite uses; jsdom is the lightest environment that implements them.
// It is a devDependency only and never ships to the browser.
//
// Why `@testing-library/react`: it renders into that DOM and queries it the way
// a user perceives it (roles, text), which is also how the a11y lint rules
// think — and it is the de-facto standard, so the next component test costs
// nothing to write. The alternative, `react-test-renderer`, is deprecated for
// React 18 and cannot dispatch real DOM events.
//
// Why `esbuild.jsx: 'automatic'`: the package tsconfig uses `jsx: preserve`
// for Next's SWC pipeline, which esbuild would honour and leave JSX untouched.
// Telling esbuild to use the automatic runtime here avoids taking a Vite React
// plugin for a test-only concern.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
