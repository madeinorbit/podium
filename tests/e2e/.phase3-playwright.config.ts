import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PORT ?? 8799)
const ORIGIN = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.browser.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalTeardown: './global-teardown.ts',
  use: { baseURL: ORIGIN },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
  ],
  webServer: [
    {
      // Harness-only, same as playwright.config.ts (POD-535): package builds live
      // in the lane / a prior `bun run build`, not under Playwright's webServer clock.
      command: 'bun --conditions=@podium/source serve-harness.ts',
      url: `${ORIGIN}/health`,
      reuseExistingServer: false,
      env: { PODIUM_PASSWORD: process.env.PODIUM_PASSWORD ?? '' },
      timeout: 180_000,
    },
  ],
})
