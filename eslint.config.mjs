// ─────────────────────────────────────────────────────────────────────────
// Flat ESLint config (ESLint 9 + typescript-eslint 8) shared across all
// packages. Run from the repo root (`pnpm lint`) so a single source of truth
// governs every workspace. Type-aware linting is intentionally off here to
// keep CI fast and avoid per-package project wiring; enable it later if needed.
// ─────────────────────────────────────────────────────────────────────────
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/generated/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  // Accessibility rules for the React surface (Session 05 ships the first
  // interactive UI). Static ARIA/semantics validation, run in CI with the rest
  // of lint: invalid roles, unlabelled controls, missing alt text, and
  // non-interactive elements given handlers all fail the build.
  {
    files: ['**/*.tsx'],
    ...jsxA11y.flatConfigs.recommended,
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // typescript-eslint handles undefined symbols via the type system.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
