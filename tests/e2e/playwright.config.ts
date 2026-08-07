import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PORT ?? 8799)
const ORIGIN = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.browser.e2e.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  // Playwright SIGKILLs the webServer tree; the harness can't reap its own durable
  // sessions on the way out, so the teardown sweeps the isolated socket dirs.
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
      // matching production since the backend-serves-web change (b7c02a3). We build model before
      // protocol because protocol's dist imports model's dist, then build the web and serve it
      // same-origin from the relay, so the browser opens its WebSocket
      // same-origin. (A separate cross-origin preview server has its client WS upgrade
      // refused, so the old two-server split no longer connects.) The specs load from the
      // baseURL (:8799) and pass `?server=ws://localhost:8799`; @podium/source runs TS source.
      //
      // Timeout is the full sequential chain (model → protocol → web → mobile export →
      // serve-harness), not harness boot alone. serve-harness answers /health in ~5s;
      // the four builds routinely exceed the old 180s budget even on turbo/Metro cache
      // hits under host load (POD-535). 10 minutes leaves headroom without changing the
      // cold-checkout self-containment of this command (POD-1389).
      command:
        'bun run --filter @podium/model build && bun run --filter @podium/protocol build && bun run --filter @podium/web build && bun run --filter @podium/mobile build:web && bun --conditions=@podium/source serve-harness.ts',
      env: { ...process.env, PODIUM_UPDATE_CHANNEL: 'edge' },
      url: `${ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 600_000,
    },
  ],
})
