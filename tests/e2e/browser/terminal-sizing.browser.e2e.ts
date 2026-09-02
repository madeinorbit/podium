import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * THE REPORTED BUG, IN A REAL BROWSER (POD-3239, SPEC-1 acceptance).
 *
 * The complaint: switching a session from chat to the CLI shows a terminal in
 * the top-left quadrant — an 80x24 grid — for a beat before it snaps to the real
 * size. 80x24 is xterm's own constructor default, and under MODEL rule 2 no path
 * may put a buffer at anything but W, so the assertion is flat: after the switch,
 * no grid of 80x24 is ever constructed or applied.
 *
 * WHY THE FIXTURE MATTERS. `PODIUM_E2E_TERMINAL_SIZING=1` leaves the server
 * holding 132x43 — neither xterm's default nor anything this viewport measures
 * to. Against a session sitting at 80x24 these assertions would be vacuous: a
 * buffer born at W and a buffer born at the default would look identical.
 *
 * BOTH SCENARIOS FROM SPEC-0a:
 *   cold — the first-ever switch to the CLI, which MOUNTS the terminal. 0a
 *          confirmed this as a real producer of an 80x24 grid (behind the
 *          startup overlay, corrected 10-14 ms later by a fit).
 *   warm — chat, wait, back to the CLI, with the terminal still mounted. 0a
 *          found no movement here and this pins that it stays that way.
 *
 * The screenshot is an assertion too: `first-frame` is taken as soon as the
 * terminal has content on screen, and the grid it was taken at is asserted from
 * the DOM in the same breath — a picture nobody checks proves nothing.
 */
test.skip(({ isMobile }) => isMobile, 'desktop panel verification')

/** The grid PODIUM_E2E_TERMINAL_SIZING leaves the server holding. */
const W = { cols: 132, rows: 43 }

interface Entry {
  event: string
  data: Record<string, unknown>
}

const trace = (page: import('@playwright/test').Page): Promise<Entry[]> =>
  page.evaluate(
    () => (globalThis.__podiumTerminalDiagnostics?.snapshot() ?? []) as unknown as Entry[],
  )

/** The grid a trace entry's view snapshot was at, when it carries one. */
const gridOf = (entry: Entry | undefined): { cols: number; rows: number } | undefined =>
  (entry?.data.view as { grid?: { cols: number; rows: number } } | undefined)?.grid

/** The grid xterm is ACTUALLY rendering, read off the DOM rather than trusted
 *  from the app's own bookkeeping. */
const domGrid = (page: import('@playwright/test').Page): Promise<{ cols: number; rows: number }> =>
  page.evaluate(() => {
    const rows = document.querySelectorAll('.xterm-rows > div').length
    const firstRow = document.querySelector('.xterm-rows > div')
    const cols = firstRow ? firstRow.querySelectorAll('span').length : 0
    return { cols, rows }
  })

test('a chat → CLI switch never paints the default grid, cold or warm', async ({ page }) => {
  test.setTimeout(240_000)
  test.fail(
    process.env.PODIUM_E2E_TERMINAL_SIZING !== '1',
    'needs PODIUM_E2E_TERMINAL_SIZING=1 on the harness server — without a session the server already holds at a non-default grid these assertions are vacuous',
  )
  await page.setViewportSize({ width: 1400, height: 900 })
  // Start in CHAT: the switch to the CLI is the subject, so the terminal must
  // not already be mounted when the run begins.
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'chat'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  // The harness has more than one task, so the workspace does not open ours by
  // itself — click it in the sidebar, as an operator would.
  await page
    .getByRole('button', { name: /Terminal sizing subject/ })
    .first()
    .click()
  await expect(page.getByTestId('agent-panel-header')).toContainText('Sizing panel subject', {
    timeout: 60_000,
  })
  const chat = page.getByRole('tab', { name: 'Chat', exact: true }).locator('visible=true')
  const cli = page.getByRole('tab', { name: 'CLI', exact: true }).locator('visible=true')
  await expect(cli).toBeVisible({ timeout: 60_000 })
  if ((await chat.getAttribute('aria-selected')) !== 'true') await chat.click()
  await expect(chat).toHaveAttribute('aria-selected', 'true')
  // Nothing mounted yet — this is what makes the next click a COLD mount.
  await expect(page.locator('.xterm-screen')).toHaveCount(0)

  // ---- COLD ----------------------------------------------------------------
  await page.evaluate(() => globalThis.__podiumTerminalDiagnostics?.clear())
  await cli.click()
  await expect(page.locator('.xterm-screen')).toHaveCount(1, { timeout: 60_000 })

  const cold = await trace(page)
  const mount = cold.find((e) => e.event === 'mount')
  expect(mount, 'the switch mounted a terminal').toBeDefined()
  // THE HEADLINE. The buffer is CONSTRUCTED at W. Before POD-3239 this read
  // 80x24 on every cold mount, whatever the server was holding.
  expect(gridOf(mount), 'constructed at the session grid, not at xterm’s default').toEqual(W)

  // …and nothing after it ever moves the buffer to the default either.
  for (const entry of cold) {
    expect(gridOf(entry), `no 80x24 grid at any point in the switch (${entry.event})`).not.toEqual({
      cols: 80,
      rows: 24,
    })
  }
  // The ladder vocabulary is gone from the trace, not merely unused.
  const coldEvents = cold.map((e) => e.event)
  expect(coldEvents).not.toContain('fit:retry-start')
  expect(coldEvents).not.toContain('reveal:fit-mismatch')
  expect(coldEvents.some((e) => e.startsWith('anomaly:'))).toBe(false)
  // One ask, and it is the reveal's claim (rule 4 — the claim is the point).
  const asks = cold.filter((e) => e.event === 'ask:sent')
  expect(asks.length, 'one ask on a cold switch').toBeLessThanOrEqual(1)

  // PAINT EVIDENCE. The first frame with terminal content on screen, and the
  // grid it is at, asserted together.
  await expect(page.locator('.xterm-rows > div').first()).toBeVisible({ timeout: 30_000 })
  const coldPainted = await domGrid(page)
  expect(coldPainted.rows, 'the painted terminal is at the session grid').toBe(W.rows)
  await page
    .getByTestId('terminal-surface')
    .screenshot({ path: 'docs/shots/pod3239-cold-first-frame.png' })

  // ---- WARM ----------------------------------------------------------------
  // Chat, a real pause, then back. The terminal stays mounted across the toggle.
  await chat.click()
  await page.waitForTimeout(3_000)
  await page.evaluate(() => globalThis.__podiumTerminalDiagnostics?.clear())
  await cli.click()
  await expect(page.locator('.xterm-screen')).toHaveCount(1, { timeout: 30_000 })
  await page.waitForTimeout(1_000)

  const warm = await trace(page)
  expect(
    warm.some((e) => e.event === 'mount'),
    'the terminal stayed mounted',
  ).toBe(false)
  for (const entry of warm) {
    expect(gridOf(entry), `no 80x24 grid on the warm reveal (${entry.event})`).not.toEqual({
      cols: 80,
      rows: 24,
    })
  }
  const warmPainted = await domGrid(page)
  expect(warmPainted, 'the warm reveal did not move the grid at all').toEqual(coldPainted)
  await page
    .getByTestId('terminal-surface')
    .screenshot({ path: 'docs/shots/pod3239-warm-first-frame.png' })
})
