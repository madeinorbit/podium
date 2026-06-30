import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp } from './_harness'

// Regression guard for the reveal path (session-mount.reveal): a session hidden behind
// another tab (display:none, which frees its WebGL canvas) must, when revealed, re-fit its
// grid to the CURRENT viewport — never stay stuck at the grid it last fitted (which now
// overflows a shrunk box) nor collapse to the quarter-size default.
//
// We can't read the hidden session's state() via window.__podium — that API is set at MOUNT
// time and switching to an already-warm panel doesn't remount it. Instead measure the VISIBLE
// terminal from the DOM: the ratio of the rendered .xterm-screen width to its .term container
// width. ~1.0 = the grid fills its box (correctly fitted); >>1 = a stale, too-wide grid
// overflowing the shrunk box (reveal failed to re-fit). The black-screen / dead-scroll visual
// recovery is GPU-specific (software WebGL here preserves the backing store across
// display:none, so it can't be reproduced headless); this asserts the grid axis, which IS
// observable.

const tabIds = (page: Page): Promise<string[]> =>
  page.$$eval('.overflow-x-auto [data-session]', (els) =>
    (els as HTMLElement[]).map((el) => el.dataset.session ?? ''),
  )

const fitRatio = (page: Page): Promise<{ termW: number; screenW: number; ratio: number }> =>
  page.evaluate(() => {
    const term = [...document.querySelectorAll('.term[data-role]')].find(
      (t) => (t as HTMLElement).clientWidth > 10 && (t as HTMLElement).offsetParent !== null,
    ) as HTMLElement | undefined
    const screen = term?.querySelector('.xterm-screen') as HTMLElement | undefined
    const termW = term?.clientWidth ?? -1
    const screenW = screen?.clientWidth ?? -1
    return { termW, screenW, ratio: termW > 0 ? +(screenW / termW).toFixed(2) : 0 }
  })

test('revealing a hidden session re-fits its grid to the current viewport', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await openApp(page)

  const pre = new Set(await tabIds(page))
  await newSession(page, 'Shell') // A — active, fits the wide viewport
  await newSession(page, 'Shell') // B — now active; A is hidden (display:none)
  const mine = (await tabIds(page)).filter((id) => !pre.has(id))
  expect(mine.length, 'created exactly two sessions').toBe(2)
  const a = mine[0]

  // While A is hidden, shrink the viewport. A can't re-fit while it isn't the active pane, so
  // its grid is now stale (too wide) for the smaller box. Stay above the 768px mobile
  // breakpoint so the desktop tab strip we click stays mounted.
  await page.setViewportSize({ width: 820, height: 900 })
  await page.waitForTimeout(500)

  // Reveal A by clicking its tab → setActive(true) → reveal() re-fits it to the 820px box.
  await page.locator(`.overflow-x-auto [data-session="${a}"]`).click({ timeout: 15_000 })

  // The reveal fit retries across frames + a server round-trip; poll until the visible grid
  // settles to filling its box (not the stale, overflowing 1400px grid).
  await expect
    .poll(async () => (await fitRatio(page)).ratio, {
      timeout: 15_000,
      message: 'revealed terminal should re-fit to fill its 820px box',
    })
    .toBeLessThan(1.12)

  const fit = await fitRatio(page)
  console.log(`revealed A fit at 820px: ${JSON.stringify(fit)}`)
  expect(fit.ratio, `revealed terminal fills its box (got ${JSON.stringify(fit)})`).toBeGreaterThan(0.85)
})

// A same-viewport reveal must repaint the freed canvas WITHOUT swapping the renderer. A swap
// (dispose+recreate the WebGL addon) replaces the <canvas> element AND silently leaves xterm's
// Viewport row-height cache stale → wheel scrolling dies until the next real resize. We prove
// "no swap" by tagging the canvas while visible and asserting the SAME element survives reveal.
const visibleCanvasProbe = (page: Page): Promise<{ hasCanvas: boolean; probe: string | null }> =>
  page.evaluate(() => {
    const term = [...document.querySelectorAll('.term[data-role]')].find(
      (t) => (t as HTMLElement).clientWidth > 10 && (t as HTMLElement).offsetParent !== null,
    )
    const canvas = term?.querySelector('.xterm-screen canvas') as HTMLCanvasElement | undefined
    return { hasCanvas: !!canvas, probe: canvas?.dataset.revealProbe ?? null }
  })

test('same-viewport reveal repaints without swapping the WebGL canvas (scroll-safe)', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1400, height: 900 })
  await openApp(page)

  const pre = new Set(await tabIds(page))
  await newSession(page, 'Shell') // A — active; tag its live WebGL canvas
  const tagged = await page.evaluate(() => {
    const term = [...document.querySelectorAll('.term[data-role]')].find(
      (t) => (t as HTMLElement).clientWidth > 10 && (t as HTMLElement).offsetParent !== null,
    )
    const canvas = term?.querySelector('.xterm-screen canvas') as HTMLCanvasElement | undefined
    if (canvas) canvas.dataset.revealProbe = 'A'
    return !!canvas
  })
  expect(tagged, 'A has a WebGL canvas to tag (software WebGL in CI)').toBe(true)

  await newSession(page, 'Shell') // B — A is hidden (display:none frees A's canvas backing store)
  const mine = (await tabIds(page)).filter((id) => !pre.has(id))
  const a = mine[0]

  // Reveal A at the SAME viewport → grid unchanged → repaintRecover (clear atlas in place),
  // NOT a renderer swap. A swap would remove the tagged canvas and append a fresh one.
  await page.locator(`.overflow-x-auto [data-session="${a}"]`).click({ timeout: 15_000 })
  await page.waitForTimeout(1200)

  const after = await visibleCanvasProbe(page)
  console.log(`after same-viewport reveal: ${JSON.stringify(after)}`)
  expect(after.hasCanvas, 'revealed terminal still has a WebGL canvas').toBe(true)
  expect(after.probe, 'the SAME canvas survived reveal (no renderer swap → Viewport scroll cache intact)').toBe('A')
})
