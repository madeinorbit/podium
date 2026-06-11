import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.browser.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  // Playwright SIGKILLs the webServer tree; the harness can't reap its own durable
  // sessions on the way out, so the teardown sweeps the isolated socket dirs.
  globalTeardown: './global-teardown.ts',
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
    { name: 'webkit-iphone', use: { ...devices['iPhone 13'] } },
  ],
  webServer: [
    {
      // Relay + daemon (real shell for `shell`, keyecho jig otherwise). The specs connect
      // via `?server=ws://localhost:8799`; the @podium/source condition runs TS source.
      command: 'node --conditions=@podium/source --import tsx serve-harness.ts',
      url: 'http://localhost:8799/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        'bun run --filter @podium/web build && bun run --filter @podium/web preview -- --port 4317 --strictPort',
      url: 'http://localhost:4317',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
