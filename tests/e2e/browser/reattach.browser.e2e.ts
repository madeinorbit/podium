import { expect, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

const MARKER = 'REATTACH_MARKER_8F3A'

// Re-mounting the terminal (the agent keeps running) must restore the screen via the
// server's replay-on-attach buffer, not leave it blank. Crossing the 768px mobile
// breakpoint and back unmounts + remounts the panel — a real detach/re-attach.
test('re-mounting the terminal restores prior output via replay', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openApp(page)
  await newSession(page, 'Shell')

  await podium.send(page, `printf '%s\\n' ${MARKER}\r`)
  await page.waitForFunction(
    (m) => {
      const w = window as unknown as { __podium?: { screenText(): string } }
      return (w.__podium?.screenText() ?? '').includes(m)
    },
    MARKER,
    { timeout: 10_000 },
  )

  // Desktop -> mobile -> desktop: the panel remounts each way (detach + re-attach).
  await page.setViewportSize({ width: 700, height: 900 })
  await page.waitForTimeout(800)
  await page.setViewportSize({ width: 1400, height: 900 })

  // The re-mounted desktop panel must replay the marker back onto a fresh terminal.
  await page.waitForFunction(
    () => !!(window as unknown as { __podium?: unknown }).__podium,
    undefined,
    { timeout: 15_000 },
  )
  await expect
    .poll(async () => (await podium.screen(page)).includes(MARKER), { timeout: 10_000 })
    .toBe(true)
})
