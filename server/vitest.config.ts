import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/env.ts'],
    testTimeout: 30000,
    hookTimeout: 120000,
    pool: 'forks',
    fileParallelism: false,
  },
});
