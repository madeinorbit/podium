/**
 * Shared helpers for the browser e2e specs. They drive the real Live UI against the
 * harness relay (tests/e2e/serve-harness.ts) using the `?e2e=1` test API that AgentPanel
 * exposes on `globalThis.__podium` (screenText / state / sendInput / simulateKeyboard).
 *
 * The casts below are type-only and erased at build time, so the functions passed to
 * page.evaluate() run as plain `window.__podium.…()` in the browser.
 */
import { expect, type Page } from '@playwright/test'
import { loginTestClient } from '../../../apps/server/src/test-support/client-auth'
import { CodexReadinessBoundary } from '../codex-readiness'

/** ws:// origin of the harness relay; PORT lets concurrent harness runs stay isolated. */
export const RELAY =
  process.env.PODIUM_RELAY ?? `ws://localhost:${Number(process.env.PORT ?? 8799)}`
const HTTP = RELAY.replace(/^ws/, 'http')

interface PodiumTestApi {
  screenText(): string
  screenHash(opts?: { dropDim?: boolean }): string
  composerInputReady(kind: string): boolean
  state(): { cols: number; rows: number; role: string; sessionId?: string }
  sendInput(data: string): void
  simulateKeyboard(inset: number): void
}
type TestWindow = Window & { __podium?: PodiumTestApi }

/** Open the Live UI home pointed at the harness relay, with the e2e test API enabled. */
export async function openHome(page: Page): Promise<void> {
  // Force the native terminal view: these specs drive the real PTY substrate
  // (the test API lives on the mounted xterm session), so pin the panel mode
  // through the same persistence channel a user would, rather than a production
  // E2E branch in the app. Must run before app code, so before goto.
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'native'))
  // A password inherited by the isolated server enables the production cookie
  // gate. Authenticate through the real route and install its real session
  // cookie before app code opens `/auth/status` and `/client`.
  const password = process.env.PODIUM_PASSWORD?.trim()
  if (password) {
    const login = await loginTestClient({ origin: HTTP, password })
    await page.context().addCookies([
      {
        name: login.cookieName,
        value: login.cookieValue,
        url: HTTP,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ])
  }
  // Phone user agents get the web shell at `/` directly since #58 — no cookie
  // opt-out needed; `?server`/`?e2e` survive the load [spec:SP-902c].
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
}

/** Open the Live UI and enter a workspace. */
export async function openApp(page: Page): Promise<void> {
  await openHome(page)
  await gotoWorkspace(page)
}

/**
 * The app lands on the home view; these specs exercise the workspace. The work
 * list is work-centric: it only lists rows for worktrees/issues that already
 * have work. Click the top work row when one exists (reopening the workspace
 * the most recent sessions live in — same tab-order key); on a fresh empty
 * state the only path into a workspace is spawning, so click the
 * `New <Agent> in <Repo>` split button (optimistic spawn navigates
 * immediately).
 *
 * Desktop renders that list in an always-present <aside>. Mobile renders the
 * same rows as its home view (#227), reached via the header's Work button — so
 * both layouts take the same path, differing only in where the rows live.
 */
export async function gotoWorkspace(page: Page): Promise<void> {
  // If the "New panel" button is already visible we're already in the workspace.
  const newPanelBtn = page.locator('button[aria-label="New panel"]:visible').first()
  if (await newPanelBtn.isVisible().catch(() => false)) {
    return
  }

  // Desktop layout renders an <aside> sidebar. Mobile renders MobileApp without
  // one; there the work list is the home view, so navigate to it first.
  const sidebar = page.getByRole('complementary').first()
  const mobileShell = page.locator('.mobile-shell')
  // The loading element can disappear before the React shell mounts. Wait for
  // either real layout instead of guessing mobile when desktop is merely slow.
  await sidebar.or(mobileShell).first().waitFor({ state: 'visible', timeout: 60_000 })
  const onDesktop = await sidebar.isVisible()
  const list = onDesktop ? sidebar : mobileShell
  if (!onDesktop) await page.locator('button[title="Tasks"]').click({ timeout: 15_000 })

  // Work rows load with the repos/sessions feeds — give the top row a
  // loaded-host window (15s) to appear (it exists whenever earlier specs or a pre-reload page
  // already created sessions). Its main select button carries flex-1 (the
  // sibling chevron button, when present, is the expand toggle).
  const firstRow = list
    .locator('[data-testid="unified-worktree-row"], [data-testid="unified-issue-row"]')
    .first()
  const rowVisible = await firstRow
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (rowVisible) {
    await firstRow.locator('button.flex-1').first().click()
  } else {
    // Empty state — start a task in the first repo and launch it as it stands.
    // Since f22417ba3 the sidebar has no `New <Agent> in <Repo>` chip: a task
    // opens the launch composer, and Launch with no prompt is the chip's old
    // draft spawn (the default agent, which the harness runs as keyecho).
    await list.getByRole('button', { name: 'Start first task' }).first().click({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Start work' }).click({ timeout: 30_000 })
  }
  // Confirm the workspace loaded by waiting for the "New panel" button.
  await newPanelBtn.waitFor({ state: 'visible', timeout: 15_000 })
}

/** Create a session of the given kind and wait for its test API to attach. */
export async function newSession(
  page: Page,
  kind: 'Claude' | 'Codex' | 'Grok' | 'Shell',
): Promise<void> {
  // The test API follows the ACTIVE panel, and the panel that held it may set it
  // again while the new one mounts — so "it exists" is not "the new session has
  // it". Wait for it to name a different session than the one active before.
  const before = await page.evaluate(
    () => (window as unknown as TestWindow).__podium?.state().sessionId,
  )
  await page.evaluate(() => {
    delete (window as unknown as TestWindow).__podium
  })
  // One path for every kind: the workspace `+` menu lists `New Shell` after the
  // agents (NewPanelMenu). The sidebar's `New Shell in <Repo>` chip and its
  // `Choose agent and repo` menu went with f22417ba3.
  await page.locator('button[aria-label="New panel"]:visible').first().click({ timeout: 15_000 })
  const item = page.getByRole('menuitem', { name: `New ${kind}` })
  await item.waitFor({ state: 'visible', timeout: 10_000 })
  // The real click a user performs. A dispatched click was used to dodge the item
  // detaching as the pick re-renders the sidebar, but it does not reliably select:
  // it left the menu open with nothing spawned, and a dispatched `New Shell`
  // spawned without activating. The item may detach mid-click, so a click error
  // is not the verdict; the attach below is.
  await item.click({ timeout: 10_000 }).catch(() => {})
  const deadline = Date.now() + 20_000
  for (;;) {
    const active = await page.evaluate(
      () => (window as unknown as TestWindow).__podium?.state().sessionId,
    )
    if (active !== undefined && active !== before) break
    if (Date.now() > deadline) {
      throw new Error(`newSession(${kind}): the new session's terminal test API never attached`)
    }
    // The test API lives on the terminal view. A panel opens in Chat when the
    // account's view default says so, and that default is synced ui-state: the
    // localStorage pin in openHome only seeds it, so one suite that picked Chat
    // puts every later suite on the lane's shared server in Chat. Pick CLI, as
    // an operator would.
    const cli = page.locator('[data-testid="mode-native"][aria-selected="false"]:visible').first()
    if (await cli.isVisible().catch(() => false)) await cli.click().catch(() => {})
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(800)
}

const CODEX_READY_QUIET_MS = 1_500

/**
 * Wait for Codex's real input boundary, not merely a non-empty terminal. A
 * redraw changes the dim-stripped screen hash and restarts the quiet window, so
 * MCP startup cannot paint a transient composer and race the synthetic send.
 */
export async function waitForCodexReady(page: Page): Promise<void> {
  const boundary = new CodexReadinessBoundary(CODEX_READY_QUIET_MS)
  await expect
    .poll(
      async () => {
        const sample = await page.evaluate(() => {
          const api = (window as unknown as TestWindow).__podium
          return {
            ready: api?.composerInputReady('codex') ?? false,
            hash: api?.screenHash({ dropDim: true }) ?? '',
          }
        })
        return boundary.observe(sample, Date.now())
      },
      { timeout: 120_000, intervals: [100, 200, 300] },
    )
    .toBe(true)
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
