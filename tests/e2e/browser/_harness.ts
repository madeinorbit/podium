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
  // Force the native terminal view: these specs drive the real PTY substrate
  // (the test API lives on the mounted xterm session), so pin the panel mode
  // through the same persistence channel a user would, rather than a production
  // E2E branch in the app. Must run before app code, so before goto.
  await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  // Wait for the app to finish its cold-start load. The loading screen shows
  // "Loading Podium…" — wait until that is GONE (i.e. the .app-loading element
  // has been removed from the DOM), which means the app shell has rendered.
  // Fallback: if the loading element never appeared, just check it's gone anyway.
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })

  const repoDialog = page.getByRole('dialog', { name: 'Find repositories' })
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole('button', { name: 'Close' }).click()
  }

  await gotoWorkspace(page)
}

/**
 * The app lands on the command-center home view; these specs exercise the
 * workspace. Desktop: click the first sidebar worktree (which switches views),
 * then wait for the "New panel" button to confirm the workspace is active.
 * Mobile: the workspace strip is always present, so nothing to do.
 */
export async function gotoWorkspace(page: Page): Promise<void> {
  // If the "New panel" button is already visible we're already in the workspace.
  const newPanelBtn = page.locator('button[aria-label="New panel"]:visible').first()
  if (await newPanelBtn.isVisible().catch(() => false)) {
    return
  }

  // Desktop layout renders an <aside> sidebar. Mobile renders MobileApp without
  // the aside. Wait up to 10s for the sidebar to appear; if it doesn't, we're on
  // mobile (or the workspace is already rendered another way) — bail.
  const sidebar = page.locator('aside').first()
  try {
    await sidebar.waitFor({ state: 'visible', timeout: 10_000 })
  } catch {
    // Mobile layout — the workspace strip is always present on mobile; bail.
    return
  }

  // Repos load async — wait for the main worktree row. Current sidebar
  // layouts expose the row as a button whose accessible name ends with the
  // `main` badge, e.g. `main main` or `<branch> main`.
  const mainWorktreeBtn = sidebar.getByRole('button', { name: /(^|\s)main$/ }).first()
  await mainWorktreeBtn.waitFor({ state: 'visible', timeout: 15_000 })
  await mainWorktreeBtn.click()
  // Confirm the workspace loaded by waiting for the "New panel" button.
  await newPanelBtn.waitFor({ state: 'visible', timeout: 15_000 })
}

/** Create a session of the given kind and wait for its test API to attach. */
export async function newSession(page: Page, kind: 'Claude' | 'Codex' | 'Shell'): Promise<void> {
  // Clear any existing __podium from a prior active session so we can distinguish
  // when the NEW session's AgentPanel sets it (avoids resolving immediately on a
  // stale reference when tests share the same relay/sessions).
  await page.evaluate(() => {
    delete (window as unknown as TestWindow).__podium
  })
  await page.locator('button[aria-label="New panel"]:visible').first().click({ timeout: 15_000 })
  await page.getByRole('menuitem', { name: `New ${kind}` }).click({ timeout: 10_000 })
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
