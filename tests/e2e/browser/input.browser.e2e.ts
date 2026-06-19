import { expect, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

// keyecho echoes every byte it receives with hex + a human label, so we can assert that
// real browser keyboard, click and wheel events survive the full browser -> server ->
// daemon -> PTY -> agent path. (The harness launches keyecho for non-shell kinds.)
// Desktop pointer semantics only: mouse.wheel doesn't exist on touch devices (mobile
// WebKit rejects it outright) — mobile-scroll.browser.e2e.ts covers finger drag.
test.skip(({ isMobile }) => isMobile, 'desktop pointer input; mobile covered by mobile-scroll')

test('keyboard, click and scroll round-trip to the agent (keyecho)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 })
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

  // Real mouse click to focus the terminal (also exercises mouse-button reporting).
  // The keep-mounted panel deck leaves hidden sessions' terminals in the DOM; target
  // the VISIBLE one (the active session, which __podium/screenText also refers to).
  const box = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.xterm-screen')) as HTMLElement[]
    const el = els.find((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ?? els[0]
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const cx = Math.round(box.x + box.w / 2)
  const cy = Math.round(box.y + box.h * 0.55)
  await page.mouse.click(cx, cy)

  // Keyboard: printable text + control keys.
  await page.keyboard.type('podium')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+c')

  // Scroll wheel over the terminal.
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, -120)
  await page.mouse.wheel(0, 120)

  // keyecho's visible log scrolls, so accumulate snapshots rather than trusting one read.
  let seen = ''
  await expect
    .poll(
      async () => {
        seen += await podium.screen(page)
        return /Enter|Return/.test(seen) && /Ctrl\+C/.test(seen) && /Mouse|wheel/i.test(seen)
      },
      { timeout: 10_000 },
    )
    .toBe(true)

  expect(seen, 'typed bytes echoed (0x70 = p)').toMatch(/\b70\b|podium/)
  expect(seen, 'Enter echoed').toMatch(/Enter|Return/)
  expect(seen, 'Ctrl+C echoed').toMatch(/Ctrl\+C/)
  expect(seen, 'mouse click + wheel echoed').toMatch(/Mouse|wheel/i)
})
