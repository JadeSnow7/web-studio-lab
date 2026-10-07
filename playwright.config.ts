import { defineConfig } from '@playwright/test';

// 端到端检查驱动构建后的真实 Electron 窗口（先运行 pnpm build）。
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results/e2e',
});
