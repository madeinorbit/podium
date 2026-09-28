import type { APIRequestContext } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

const HTTP = RELAY.replace(/^ws/, 'http')

/** The server's own view of a session — including what it REFUSED (POD-3239 B6),
 *  which is the only place a request that went nowhere is visible from here. */
async function serverRow(
  request: APIRequestContext,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await request.get(`${HTTP}/trpc/sessions.list`)
  if (!response.ok()) return undefined
  const body = (await response.json()) as {
    result?: { data?: Array<Record<string, unknown>> }
  }
  return body.result?.data?.find((row) => row.name === name)
}

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

/**
 * SOFTWARE GL, so the screenshots below contain a terminal.
 *
 * xterm's WebGL renderer paints into a GPU canvas that headless Chromium
 * composites out of band, and `page.screenshot()` captures the page without it —
 * a flat rectangle whatever is on screen. 0a hit the same wall and reached for a
 * CDP screencast; swiftshader is the smaller answer here, and it changes nothing
 * this spec asserts (the grid, not the renderer).
 */
test.use({
  launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'] },
})

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

/** The size of the box xterm actually renders into. Zero until it has laid out,
 *  and renderer-independent — WebGL paints a canvas with no row elements at all,
 *  so counting `.xterm-rows > div` would be asserting which renderer loaded. */
const screenBox = (
  page: import('@playwright/test').Page,
): Promise<{ width: number; height: number }> =>
  page.evaluate(() => {
    const rect = document.querySelector('.xterm-screen')?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  })

/**
 * The grid xterm is at RIGHT NOW, read from the mount's own test API.
 *
 * Deliberately not from the diagnostics: every entry carries a `view` snapshot
 * taken when the entry was RECORDED, so the newest entry describes the view as
 * it was just BEFORE that entry's effect — one apply behind. That off-by-one is
 * easy to read as a stuck terminal, which is exactly the bug this spec is
 * looking for, so the live reading is the one to assert on.
 */
const currentGrid = (
  page: import('@playwright/test').Page,
): Promise<{ cols: number; rows: number } | undefined> =>
  page.evaluate(
    () =>
      (
        globalThis as {
          __podium?: { grid?(): { cols: number; rows: number } }
        }
      ).__podium?.grid?.() as { cols: number; rows: number } | undefined,
  )

/**
 * Wait until the buffer has arrived at the size this client last ASKED for.
 *
 * That is the end-state property worth waiting on — whatever a viewer last
 * asked for, the buffer ends up there — and waiting on it removes the race
 * between this test and the round trip it is measuring; a fixed timeout would
 * sample the middle of it and report a coincidence.
 *
 * Bounded. A buffer that never reaches its last ask leaves the assertions below
 * to fail on what they see, rather than this helper deciding anything.
 */
async function settle(page: import('@playwright/test').Page): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.waitForTimeout(500)
    const entries = await trace(page)
    const lastAsk = entries.filter((e) => e.event === 'ask:sent').at(-1)
    const grid = gridOf(entries.at(-1))
    if (lastAsk && grid && JSON.stringify(grid) === JSON.stringify(lastAsk.data.geometry)) return
  }
}

/**
 * ONE RESIZE PER REVEAL (POD-4721).
 *
 * The first switch to the CLI measured the box, asked, and then asked AGAIN
 * ~0.4-1.3 s later one or two rows smaller: the prompt chrome under the PTY
 * (a 1 px rule, plus the Claude Code hint row) was mounted only once the
 * terminal went `ready`, so it took its height out of the box AFTER the first
 * measurement. Every applied change blanks the xterm and SIGWINCHes the agent,
 * so the second one cost a second blank + redraw for nothing.
 *
 * 1400x898 puts the box on a row boundary, so even the rule alone (the 1 px
 * this was first seen as) moves the row count.
 *
 * FIRST IN THE FILE ON PURPOSE: the fixture leaves the server at W = 132x43,
 * which no box here measures to, so the reveal's single ask is a real change
 * and "exactly one apply" is a count, not a vacuous zero. The precondition
 * below refuses to run against a session some earlier test already moved.
 */
test('a cold reveal at a row boundary resizes exactly once', async ({ page, request }) => {
  test.setTimeout(240_000)
  test.fail(
    process.env.PODIUM_E2E_TERMINAL_SIZING !== '1',
    'needs PODIUM_E2E_TERMINAL_SIZING=1 on the harness server',
  )
  await page.setViewportSize({ width: 1400, height: 898 })
  await page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'chat'))
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  // The fixture reports W only once the session is live, which can trail the
  // harness's /health; wait for it rather than racing it.
  await expect
    .poll(async () => (await serverRow(request, 'Sizing panel subject'))?.geometry, {
      timeout: 60_000,
      message: 'the server holds the fixture grid',
    })
    .toEqual(W)
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
  await expect(page.locator('.xterm-screen')).toHaveCount(0)

  await page.evaluate(() => globalThis.__podiumTerminalDiagnostics?.clear())
  await cli.click()
  await expect(page.locator('.xterm-screen')).toHaveCount(1, { timeout: 60_000 })
  // The late resize came after `ready`, so wait for it, and then hold an
  // observation window as long as the slowest late resize seen (1.3 s on the
  // Mac) with margin: an ABSENCE needs a window to be observed in.
  await expect(page.getByTestId('terminal-startup-overlay')).toHaveCount(0, { timeout: 60_000 })
  await page.waitForTimeout(3_000)
  await settle(page)

  const entries = await trace(page)
  const asks = entries
    .filter((e) => e.event === 'ask:sent')
    .map((e) => `${e.data.reason as string} ${JSON.stringify(e.data.geometry)}`)
  const applied = entries.filter((e) => e.event === 'geometry:applied')
  const story = `asks: ${asks.join(' → ')}; applied: ${applied.length}`
  expect(asks, `the reveal asks once, from a box that is already final (${story})`).toHaveLength(1)
  expect(applied, `the buffer moves once (${story})`).toHaveLength(1)
  expect(await currentGrid(page), 'and it lands where it asked').toEqual(
    entries.find((e) => e.event === 'ask:sent')?.data.geometry,
  )
})

test('a chat → CLI switch never paints the default grid, cold or warm', async ({
  page,
  request,
}) => {
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

  // LET THE SWITCH FINISH BEFORE READING IT. The box-change ask is debounced by
  // 60 ms and the grid moves when the daemon's report comes back, so a trace read
  // the instant `.xterm-screen` appears would be a race between this test and the
  // thing it is measuring. Wait until the grid has been the same for two
  // consecutive reads, then read the trace once and assert against that.
  await settle(page)

  const cold = await trace(page)
  const mount = cold.find((e) => e.event === 'mount')
  expect(mount, 'the switch mounted a terminal').toBeDefined()
  // THE HEADLINE. The buffer is CONSTRUCTED at W. Before POD-3239 this read
  // 80x24 on every cold mount, whatever the server was holding.
  expect(
    gridOf(mount),
    `constructed at the session grid, not at xterm's default — mount was asked for ${JSON.stringify(mount?.data.initialGeometry)} / ${JSON.stringify(mount?.data.geometryState)}`,
  ).toEqual(W)

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
  // THE ASKS, AND THE 0a DOUBLE RESIZE. A cold switch used to ask twice: the
  // claim, then again once the box shrank 27 px after the first frame (0a saw
  // 727 → 700 px). That shrink was the prompt chrome mounting on `ready`, and
  // it was a bug, not a settle — POD-4721 lays the chrome out from the first
  // frame, and the row-boundary test above pins one ask and one apply.
  //
  // What it must NEVER do is state a size, state another, and come BACK. 0a's
  // capture caught exactly that — 104x31 → 104x33 → 104x31, two SIGWINCH
  // repaints for zero net change — and it happened because the client compared
  // its measurement against a grid seeded from the freshly constructed xterm
  // rather than against W. So the assertion is the property, not a count: no
  // size is ever asked for twice.
  const asks = cold.filter((e) => e.event === 'ask:sent')
  const asked = asks.map((e) => JSON.stringify(e.data.geometry))
  expect(asked.length, 'the switch asked for something').toBeGreaterThan(0)
  expect(new Set(asked).size, `no size asked for twice: ${asked.join(' → ')}`).toBe(asked.length)
  expect(asks[0]?.data, 'the first ask is the claim').toMatchObject({ claimControl: true })

  // PAINT EVIDENCE. The terminal has a real box on screen, and the grid it is at
  // when it gets one — asserted together, so the screenshot below is a picture of
  // something that was checked rather than a picture nobody read.
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => (await screenBox(page)).width, { timeout: 30_000 })
    .toBeGreaterThan(0)
  const coldPainted = await currentGrid(page)
  // WHERE IT ENDS UP is the size it ASKED for — this browser's box, not the
  // 132x43 it was born at. That is the model working end to end: the client
  // asked, the server forwarded, the daemon applied and reported, and the buffer
  // followed the report. What matters is that it was never at the default on the
  // way, which the scan above already pinned, and that it went there once.
  expect(coldPainted, 'never the constructor default').not.toEqual({ cols: 80, rows: 24 })
  const row = await serverRow(request, 'Sizing panel subject')
  // The CONNECTION's view of the server grid, beside the VIEW's. The two
  // disagreeing localises the fault exactly: a connection that never heard the
  // report is a transport/ordering question, one that heard it and did not apply
  // it is a mount question.
  const connection = await page.evaluate(() => {
    const api = (globalThis as { __podium?: { state(): unknown } }).__podium
    return api ? JSON.stringify(api.state()) : 'no test api'
  })
  const tail = (await trace(page))
    .slice(-24)
    .map((e) => `${e.event} ${JSON.stringify(e.data.geometry ?? gridOf(e))}`)
    .join('\n      ')
  expect(
    coldPainted,
    `the terminal ends at the size it asked for.\n    asked: ${asked.join(' → ')}\n    server: geometry=${JSON.stringify(row?.geometry)} state=${String(row?.geometryState)} gated=${String(row?.requestsGated ?? 0)} duplicate=${String(row?.requestsDuplicate ?? 0)}\n    connection: ${connection}\n    tail:\n      ${tail}`,
  ).toEqual(asks.at(-1)?.data.geometry)
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
  await settle(page)

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
  const warmPainted = await currentGrid(page)
  expect(warmPainted, 'the warm reveal did not move the grid at all').toEqual(coldPainted)
  await page
    .getByTestId('terminal-surface')
    .screenshot({ path: 'docs/shots/pod3239-warm-first-frame.png' })
})
