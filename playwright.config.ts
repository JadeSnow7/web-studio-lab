import { defineConfig } from '@playwright/test';
import path from 'node:path';

// 端到端检查驱动构建后的真实 Electron 窗口（先运行 pnpm build）。
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: !!process.env['CI'],
  timeout: 90_000,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: path.join(process.env['WSL_E2E_EVIDENCE_DIR'] ?? 'test-results/e2e', 'report.json') }]],
  outputDir: process.env['WSL_E2E_EVIDENCE_DIR'] ? path.join(process.env['WSL_E2E_EVIDENCE_DIR'], 'results') : 'test-results/e2e',
});
