import { expect, type Page, test } from '@playwright/test'
import { newSession, openApp, podium } from './_harness'

/**
 * POD-4848: a return repaints an alternate screen WITH its colours and glyphs.
 * A fresh page attaching to an alternate-screen session gets the daemon's
 * snapshot and nothing else (the server skips its raw replay), and since
 * POD-4723 that snapshot stays until the program writes again. It used to be
 * plain latin1 text: white on black, "⏵⏵" and box drawing mangled.
 *
 * A shell paints one coloured alternate frame and then sleeps, so what the
 * page shows after the reload IS the snapshot. Colour is counted from a
 * screenshot (the WebGL renderer has no DOM cells).
 */
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

// \033[?1049h enters the alternate screen; each row has a coloured background.
const PAINT = [
  "printf '\\033[?1049h\\033[H",
  '\\033[48;5;24m\\033[1;93m╭──── 漢字 box ────╮\\033[0m\\r\\n',
  '\\033[48;5;52m\\033[38;5;214m│ 😀 coloured rows │\\033[0m\\r\\n',
  '\\033[48;5;22m\\033[38;2;200;120;255m⏵⏵ auto mode on (shift+tab)\\033[0m',
  "'; sleep 900\r",
].join('')

async function frameShown(page: Page): Promise<string> {
  await expect
    .poll(async () => podium.screen(page), { timeout: 30_000, intervals: [300] })
    .toMatch(/auto mode on/)
  await page.waitForTimeout(1000)
  return podium.screen(page)
}

const line = (screen: string, needle: string) =>
  screen
    .split('\n')
    .find((l) => l.includes(needle))
    ?.trim()

test('a cold return to an alternate screen keeps its colours and glyphs', async ({
  page,
}, info) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await openApp(page)
  await newSession(page, 'Shell')
  const sessionId = await page.evaluate(
    () =>
      (window as unknown as { __podium?: { state(): { sessionId?: string } } }).__podium?.state()
        .sessionId,
  )
  await page.waitForTimeout(1500)
  await podium.send(page, PAINT)
  const before = await frameShown(page)
  const colourBefore = await colouredPixels(page)
  await visibleSurface(page).screenshot({ path: info.outputPath('before.png') })
  expect(line(before, 'auto mode on')).toContain('⏵⏵')
  expect(colourBefore, 'the frame is coloured to begin with').toBeGreaterThan(500)

  // A cold return: the fresh page attaches with nothing.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  const tab = page.locator(`[data-session="${sessionId}"]:visible`).first()
  await tab.waitFor({ state: 'visible', timeout: 30_000 })
  await tab.click()
  const after = await frameShown(page)
  const colourAfter = await colouredPixels(page)
  await visibleSurface(page).screenshot({ path: info.outputPath('after-return.png') })
  console.log(
    `[POD-4848] viewer grid after return: ${JSON.stringify(await page.evaluate(() => (window as unknown as { __podium?: { state(): { cols?: number; rows?: number } } }).__podium?.state()))}`,
  )
  console.log(`[POD-4848] coloured pixels before=${colourBefore} after-return=${colourAfter}`)
  console.log(`[POD-4848] rows after return: ${JSON.stringify(after.split('\n').slice(0, 3))}`)
  // What the viewer did after the return: a regrid (`geometry:applied`) or an
  // epoch clear keeps only the cursor's row, which a sleeping shell never repaints.
  const events = await page.evaluate(
    (id) =>
      (
        window as unknown as {
          __podiumTerminalDiagnostics?: {
            snapshot(id?: string): { event: string; data?: unknown }[]
          }
        }
      ).__podiumTerminalDiagnostics
        ?.snapshot(id)
        .map((e) => `${e.event} ${JSON.stringify(e.data ?? {}).slice(0, 160)}`),
    sessionId,
  )
  console.log(`[POD-4848] viewer events:\n${(events ?? []).join('\n')}`)
  for (const needle of ['漢字 box', 'coloured rows', 'auto mode on']) {
    expect(line(after, needle), needle).toBe(line(before, needle))
  }
  expect(colourAfter, 'the return kept the colours').toBeGreaterThan(colourBefore * 0.8)
})
