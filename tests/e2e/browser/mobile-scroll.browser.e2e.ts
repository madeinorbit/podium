import { expect, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

/**
 * Mobile input coverage, in the NATIVE device viewports (MobileApp layout, not a
 * shrunken desktop).
 *
 * Touch-drag synthesis is engine-bound:
 *  - Chromium: CDP Input.synthesizeScrollGesture is a real compositor-level touch
 *    drag (touch events, scroll latching, fling physics) — the closest thing to a
 *    finger Playwright can produce. The drag test runs there.
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
  const box = await page.evaluate(() => {
    const r = (document.querySelector('.xterm-screen') as Element).getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  return {
    cx: Math.round(box.x + box.w / 2),
    cy: Math.round(box.y + box.h * 0.5),
    h: box.h,
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

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.synthesizeScrollGesture', {
    x: cx,
    y: cy,
    yDistance: -Math.round(h * 0.4), // finger drags up = content scrolls down
    speed: 600,
    gestureSourceType: 'touch',
  })

  // keyecho's visible log scrolls, so accumulate snapshots rather than trusting one read.
  let seen = ''
  await expect
    .poll(
      async () => {
        seen += await podium.screen(page)
        return /Mouse|wheel|scroll/i.test(seen)
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  expect(seen, 'drag delivered as scroll to the agent').toMatch(/Mouse|wheel|scroll/i)
})
