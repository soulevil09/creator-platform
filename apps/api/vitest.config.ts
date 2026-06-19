import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Sets NODE_ENV=test and required secrets before any module is imported.
    setupFiles: ['./vitest.setup.ts'],
  },
});
