import { expect, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

/**
 * Mobile input coverage, in the NATIVE device viewports (MobileApp layout, not a
 * shrunken desktop).
 *
 * Touch-drag synthesis is engine-bound:
 *  - Chromium: CDP Input.dispatchTouchEvent injects real touchstart/move/end at the
 *    same layer Playwright's own touchscreen.tap uses — the closest thing to a finger
 *    it can produce. The drag test runs there. (NOT synthesizeScrollGesture: with a
 *    'touch' source it delivered no touch events to the page at all — probed
 *    2026-07-25 — so the drag test it used to drive was silently a no-op.)
 *  - WebKit: Playwright exposes only touchscreen.tap; the Touch() constructor is
 *    illegal, initTouchEvent is gone, and TouchEvent rejects plain touch points —
 *    a drag simply cannot be synthesized today (probed 2026-06-11). webkit-iphone
 *    therefore covers what IS real there: native tap + keyboard. Engine-specific
 *    touch-scroll behavior on actual iOS Safari needs a real device / manual QA.
 */
test.skip(({ isMobile }) => !isMobile, 'touch projects only')

async function openKeyecho(page: import('@playwright/test').Page): Promise<{
  cx: number
  cy: number
  h: number
}> {
  await openApp(page)
  await newSession(page, 'Claude')
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __podium?: { screenText(): string } }
      return /keyecho/.test(w.__podium?.screenText() ?? '')
    },
    undefined,
    { timeout: 15_000 },
  )
  // The VISIBLE screen: panes of earlier sessions stay mounted-but-hidden in the
  // deck, and they come FIRST in the DOM — a bare querySelector aims the touch at
  // a pane nobody can see, and the gesture reaches no PTY at all.
  const box = await page.locator('.xterm-screen:visible').first().boundingBox()
  if (!box) throw new Error('no visible terminal screen')
  return {
    cx: Math.round(box.x + box.width / 2),
    cy: Math.round(box.y + box.height * 0.5),
    h: box.height,
  }
}

test('tap + keyboard round-trip to the agent in the mobile layout (keyecho)', async ({ page }) => {
  const { cx, cy } = await openKeyecho(page)
  await page.touchscreen.tap(cx, cy) // a REAL touch on both engines
  await page.keyboard.type('mob')
  await page.keyboard.press('Enter')

  let seen = ''
  await expect
    .poll(
      async () => {
        seen += await podium.screen(page)
        return /Enter|Return/.test(seen)
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  expect(seen, 'typed bytes echoed (0x6d = m)').toMatch(/\b6d\b|mob/)
})

test('finger drag over the terminal reaches the agent as scroll (keyecho)', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'compositor touch gestures are CDP-only; WebKit cannot synthesize a drag (see header)',
  )
  const { cx, cy, h } = await openKeyecho(page)
  await page.touchscreen.tap(cx, cy)
  // Let the tap's own touch sequence (and the click the browser synthesizes from
  // it) finish: starting the drag in the same breath reads as a double-tap and
  // the second gesture is swallowed.
  await page.waitForTimeout(500)

  // A finger drag UP over the terminal = content scrolls down.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: cx, y: cy }],
  })
  const step = Math.round((h * 0.4) / 10)
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: cx, y: cy - i * step }],
    })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  // Let the agent paint what it received before sampling — keyecho redraws its
  // whole log on each event, and a read taken mid-gesture catches an empty frame.
  await page.waitForTimeout(1500)

  // keyecho's visible log scrolls, so accumulate snapshots rather than trusting one read.
  // Assert the WHEEL specifically (#339): keyecho holds mouse tracking on, and in
  // that state xterm's own touch fallback goes dead — the drag used to arrive only
  // as the click the browser synthesizes at the end of the gesture, which a looser
  // /Mouse/ match happily accepted while the pane didn't scroll at all.
  let seen = ''
  await expect
    .poll(
      async () => {
        seen += await podium.screen(page)
        return /wheelUp|wheelDown/.test(seen)
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  expect(seen, 'drag delivered to the agent as a wheel, not a click').toMatch(/wheelDown/)
})
