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
      // (POD-535). scripts/browser-lane.ts already builds those packages for the
      // test process; duplicating them under Playwright's wall clock made every
      // suite wait on a second full chain. Hand-run playwright needs a prior
      // `bun run build` and `bun run --filter @podium/mobile build:web`, or the
      // sanctioned `bun run test:browser` entry point.
      //
      // Timeout is harness boot only (~5s to /health). 180s is generous headroom,
      // not a multi-minute build budget.
      command: 'bun --conditions=@podium/source serve-harness.ts',
      env: { ...process.env, PODIUM_UPDATE_CHANNEL: 'edge' },
      url: `${ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
