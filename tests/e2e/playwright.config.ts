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
  use: { baseURL: 'http://localhost:8799' },
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
      // Relay + daemon, which ALSO serves the built web UI on its own origin (:8799) —
      // matching production since the backend-serves-web change (b7c02a3). We build the web
      // first, then serve it same-origin from the relay, so the browser opens its WebSocket
      // same-origin. (A separate cross-origin preview server has its client WS upgrade
      // refused, so the old two-server split no longer connects.) The specs load from the
      // baseURL (:8799) and pass `?server=ws://localhost:8799`; @podium/source runs TS source.
      command:
        'bun run --filter @podium/web build && node --conditions=@podium/source --import tsx serve-harness.ts',
      url: 'http://localhost:8799/health',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
