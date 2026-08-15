import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/**/*.test.ts', 'packages/core/src/index.ts'],
      thresholds: { lines: 80, functions: 75, statements: 80, branches: 70 }
    }
  }
});
