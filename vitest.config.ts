import { defineConfig } from 'vitest/config';

// テストは仮名の辞書だけで書く（このリポジトリは public。家族の実名を書かない）。
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
