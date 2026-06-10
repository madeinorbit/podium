/**
 * Shared helpers for the browser e2e specs. They drive the real Live UI against the
 * harness relay (tests/e2e/serve-harness.ts) using the `?e2e=1` test API that AgentPanel
 * exposes on `globalThis.__podium` (screenText / state / sendInput / simulateKeyboard).
 *
 * The casts below are type-only and erased at build time, so the functions passed to
 * page.evaluate() run as plain `window.__podium.…()` in the browser.
 */
import type { Page } from '@playwright/test'

/** ws:// origin of the harness relay; the playwright.config webServer binds 8799. */
export const RELAY = process.env.PODIUM_RELAY ?? 'ws://localhost:8799'

interface PodiumTestApi {
  screenText(): string
  state(): { cols: number; rows: number; role: string }
  sendInput(data: string): void
  simulateKeyboard(inset: number): void
}
type TestWindow = Window & { __podium?: PodiumTestApi }

/** Open the Live UI pointed at the harness relay, with the e2e test API enabled. */
export async function openApp(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(
    () => /feat\/|podium/i.test(document.body.innerText || ''),
    undefined,
    {
      timeout: 20_000,
    },
  )
}

/** Create a session of the given kind and wait for its test API to attach. */
export async function newSession(page: Page, kind: 'Claude' | 'Codex' | 'Shell'): Promise<void> {
  await page.click('.tab-add')
  await page.click(`.new-panel-menu >> text=New ${kind}`)
  await page.waitForFunction(() => !!(window as unknown as TestWindow).__podium, undefined, {
    timeout: 20_000,
  })
  await page.waitForTimeout(800)
}

export const podium = {
  screen: (page: Page): Promise<string> =>
    page.evaluate(() => (window as unknown as TestWindow).__podium?.screenText() ?? ''),
  cols: (page: Page): Promise<number> =>
    page.evaluate(() => (window as unknown as TestWindow).__podium?.state().cols ?? 0),
  send: (page: Page, data: string): Promise<void> =>
    page.evaluate((d) => (window as unknown as TestWindow).__podium?.sendInput(d), data),
  /** Wait until cols differs from `prev` (the terminal has refit after a viewport change). */
  waitRefit: (page: Page, prev: number): Promise<unknown> =>
    page.waitForFunction(
      (c) => (window as unknown as TestWindow).__podium?.state().cols !== c,
      prev,
      { timeout: 10_000 },
    ),
}
