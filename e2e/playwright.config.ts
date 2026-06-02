import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.browser.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4317' },
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
    {
      name: 'chromium-pixel',
      use: {
        ...devices['Pixel 7'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command:
      'bun run --filter @podium/web build && bun run --filter @podium/web preview -- --port 4317 --strictPort',
    url: 'http://localhost:4317',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
