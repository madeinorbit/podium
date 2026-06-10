import { expect, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

// 240-char ruler (repeating 0-9) so reflow wrap boundaries are obvious and checkable.
const RULER = Array.from({ length: 240 }, (_, i) => String(i % 10)).join('')

// A replacement char (0xFFFD) or NUL (0x00) on screen means a decode/reflow corruption.
function hasCorruption(t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c === 0xfffd || c === 0x00) return true
  }
  return false
}

// Resizing the browser within desktop mode (>768px) must refit the terminal and reflow
// existing wide output without losing or corrupting it. (Crossing the 768px mobile
// breakpoint remounts the panel and is covered separately; keep widths above it here.)
test('wide shell output reflows cleanly across desktop viewport resizes', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openApp(page)
  await newSession(page, 'Shell')

  await podium.send(page, 'clear\r')
  await page.waitForTimeout(400)
  await podium.send(page, `printf "%s\\n" ${RULER}\r`)
  // Wait for the ruler to render. The predicate runs in the browser, so reach into
  // window.__podium directly rather than a node-scope helper.
  await page.waitForFunction(
    (r) => {
      const w = window as unknown as { __podium?: { screenText(): string } }
      return (w.__podium?.screenText() ?? '').replace(/\s/g, '').includes(r)
    },
    RULER,
    { timeout: 10_000 },
  )

  const assertClean = async (label: string): Promise<void> => {
    const txt = await podium.screen(page)
    expect(hasCorruption(txt), `${label}: no replacement/NUL chars`).toBe(false)
    expect(txt.replace(/\s/g, ''), `${label}: ruler reconstructable`).toContain(RULER)
  }

  const wide = await podium.cols(page)
  await assertClean('wide')

  await page.setViewportSize({ width: 820, height: 900 })
  await podium.waitRefit(page, wide)
  const narrow = await podium.cols(page)
  expect(narrow, 'terminal refit narrower').toBeLessThan(wide)
  await assertClean('narrow')

  await page.setViewportSize({ width: 1400, height: 900 })
  await podium.waitRefit(page, narrow)
  expect(await podium.cols(page), 'terminal refit back to wide').toBe(wide)
  await assertClean('wide-again')
})
