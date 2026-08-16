import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkg = (name: string) =>
  resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    // workspace 包本地解析到 TS 源（发布包自身走 dist，测试/开发不受影响）
    alias: {
      '@gitlite/core': pkg('core'),
      '@gitlite/adapters-node': pkg('adapters-node'),
      '@gitlite/codegen': pkg('codegen'),
      '@gitlite/sdk': pkg('sdk'),
      '@gitlite/react': pkg('react'),
      '@gitlite/ui': pkg('ui'),
      '@gitlite/cli': pkg('cli')
    }
  },
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}', 'packages/*/test/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/**/*.test.ts', 'packages/core/src/index.ts'],
      thresholds: { lines: 80, functions: 75, statements: 80, branches: 70 }
    }
  }
});
