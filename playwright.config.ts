import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', workers: 1, retries: 0, timeout: 900000,
  outputDir: process.env.E2E_OUTPUT_DIR ?? '.qa/browser', reporter: 'list',
  use: { headless: true, channel: process.env.E2E_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
    viewport: { width: 1600, height: 1000 }, actionTimeout: 20000, navigationTimeout: 120000,
    screenshot: 'only-on-failure', trace: 'off' },
});
