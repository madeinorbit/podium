import { expect, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

// Repro for the "quarter-size window" bug: a freshly-created session becomes the
// active pane, so its first fitted resize races the store's viewState message. If
// the resize loses the race the server gate drops it and the PTY stays at the 80-col
// daemon default — a tiny terminal in a large viewport. Each new session at a wide
// viewport must fit it (>>80 cols), not stick at the default.
test('freshly created sessions fit the wide viewport (no stuck 80x24)', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openApp(page)

  const seen: number[] = []
  for (let i = 0; i < 6; i++) {
    await newSession(page, 'Shell')
    await page.waitForTimeout(600) // allow any RO-refit / heal to settle
    const cols = await podium.cols(page)
    seen.push(cols)
    console.log(`session ${i}: cols=${cols}`)
  }
  console.log(`ALL COLS: ${JSON.stringify(seen)}`)
  // A 1400px viewport fits ~180 cols; 80 = the stuck quarter-size default.
  for (const [i, cols] of seen.entries()) {
    expect(cols, `session ${i} stuck at quarter-size (cols=${cols})`).toBeGreaterThan(120)
  }
})
