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
      // matching production since the backend-serves-web change (b7c02a3). Specs load
      // from baseURL (:8799) and pass `?server=ws://localhost:8799`; @podium/source
      // runs TS source for the harness itself. (A separate cross-origin preview had
      // its client WS upgrade refused, so the old two-server split no longer connects.)
      //
      // Builds are NOT here. model → protocol → web → mobile export used to sit in
      // this command and routinely spent 100–190s before serve-harness started,
      // which under shared-host load blew the old 180s budget with zero tests run
      // (POD-535). scripts/browser-lane.ts builds them for the full lane; hand-runs
      // (forced until POD-536 can select one suite) must call
      // `bun scripts/browser-lane.ts --build-only` first. browser-dist-preflight.ts
      // fails fast with that command when dist is missing, instead of a cryptic
      // module-not-found deep in the test process.
      //
      // Timeout is harness boot only (~5s to /health). 180s is generous headroom,
      // not a multi-minute build budget.
      command:
        'bun browser-dist-preflight.ts && bun --conditions=@podium/source serve-harness.ts',
      env: { ...process.env, PODIUM_UPDATE_CHANNEL: 'edge' },
      url: `${ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
