import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

/**
 * POD-4848, real Claude: a return repaints the screen WITH its colours and
 * glyphs. On an alternate-screen session the returning viewer gets the
 * daemon's snapshot and nothing else (the server skips its raw replay), and
 * since POD-4723 that snapshot stays until Claude writes again. It used to be
 * plain latin1 text: white on black, "⏵⏵" mangled.
 *
 * No prompt is sent — an idle Claude writes nothing after its first frame, so
 * what the page shows after a return IS the snapshot. Colour is counted from a
 * screenshot of the terminal (the WebGL renderer has no DOM cells): saturated
 * pixels before the return versus after it.
 */
test.skip(() => process.env.PODIUM_E2E_REAL_AGENTS !== '1', 'real-agent run only')
test.skip(({ isMobile }) => isMobile, 'desktop only')

const visibleSurface = (page: Page) =>
  page.locator('[data-testid="terminal-surface"]:visible').first()

/** Pixels whose channels spread by more than 60: coloured, not grey/white/black. */
async function colouredPixels(page: Page): Promise<number> {
  const png = await visibleSurface(page).screenshot()
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const canvas = new OffscreenCanvas(img.width, img.height)
    const g = canvas.getContext('2d')
    if (!g) return -1
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] ?? 0
      const gr = d[i + 1] ?? 0
      const bl = d[i + 2] ?? 0
      if (Math.max(r, gr, bl) - Math.min(r, gr, bl) > 60) n += 1
    }
    return n
  }, png.toString('base64'))
}

async function settledScreen(page: Page): Promise<string> {
  await expect
    .poll(async () => podium.screen(page), { timeout: 90_000, intervals: [500] })
    .toMatch(/auto mode/)
  await page.waitForTimeout(1500)
  return podium.screen(page)
}

test('real claude: a return keeps the colours and the ⏵⏵ glyphs', async ({ page }, info) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Claude')
  const before = await settledScreen(page)
  const colourBefore = await colouredPixels(page)
  await info.attach('before.png', {
    body: await visibleSurface(page).screenshot(),
    contentType: 'image/png',
  })
  const sessionId = await page.evaluate(
    () =>
      (window as unknown as { __podium?: { state(): { sessionId?: string } } }).__podium?.state()
        .sessionId,
  )
  expect(colourBefore, 'Claude drew in colour to begin with').toBeGreaterThan(200)

  // A cold return: a fresh page attaches with nothing, so the alternate screen
  // is rebuilt from the daemon's snapshot alone.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  const tab = page.locator(`[data-session="${sessionId}"]:visible`).first()
  await tab.waitFor({ state: 'visible', timeout: 30_000 })
  await tab.click()
  const after = await settledScreen(page)
  const colourAfter = await colouredPixels(page)
  await info.attach('after-return.png', {
    body: await visibleSurface(page).screenshot(),
    contentType: 'image/png',
  })
  console.log(`[POD-4848] coloured pixels before=${colourBefore} after-return=${colourAfter}`)
  console.log(`[POD-4848] ⏵⏵ line after return: ${after.split('\n').find((l) => l.includes('⏵⏵'))}`)
  expect(after.split('\n').some((l) => l.includes('⏵⏵'))).toBe(true)
  expect(after).not.toContain('�')
  expect(
    before
      .split('\n')
      .find((l) => l.includes('⏵⏵'))
      ?.trim(),
  ).toBe(
    after
      .split('\n')
      .find((l) => l.includes('⏵⏵'))
      ?.trim(),
  )
  expect(colourAfter, 'the return kept the colours').toBeGreaterThan(colourBefore * 0.5)
})
