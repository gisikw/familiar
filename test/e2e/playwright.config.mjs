import { createRequire } from 'node:module';
const { defineConfig } = createRequire(import.meta.url)('@playwright/test');

export default defineConfig({
  testDir: '.',
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['line']],
  outputDir: `${process.env.FAMILIAR_E2E_ARTIFACTS || 'artifacts'}/playwright`,
  use: {
    baseURL: process.env.FAMILIAR_E2E_URL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    headless: true,
    screenshot: 'off',
  },
});
