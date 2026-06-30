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
