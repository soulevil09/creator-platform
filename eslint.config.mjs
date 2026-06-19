// ─────────────────────────────────────────────────────────────────────────
// Flat ESLint config (ESLint 9 + typescript-eslint 8) shared across all
// packages. Run from the repo root (`pnpm lint`) so a single source of truth
// governs every workspace. Type-aware linting is intentionally off here to
// keep CI fast and avoid per-package project wiring; enable it later if needed.
// ─────────────────────────────────────────────────────────────────────────
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

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
