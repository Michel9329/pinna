/**
 * Pinna - end-to-end tests in real browsers: Chromium, Firefox and WebKit
 * against a local `wrangler dev`. Run: `bun run test:e2e`. A single worker:
 * the three browsers run one after the other on the same local D1, each with
 * its own sample users (data.ts).
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts$/,
  outputDir: './.results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: {
    headless: true,
    locale: 'en-US',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    // Throwaway https certificate created by the globalSetup (setup-lib.ts).
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], locale: 'en-US', viewport: { width: 1600, height: 1000 }, launchOptions: { args: ['--mute-audio'] } },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        locale: 'en-US',
        viewport: { width: 1600, height: 1000 },
        launchOptions: { firefoxUserPrefs: { 'media.volume_scale': '0.0' } },
      },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], locale: 'en-US', viewport: { width: 1600, height: 1000 } },
    },
  ],
});
