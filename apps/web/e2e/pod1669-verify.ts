/**
 * POD-1669 — THE TWO ADDITIONS, IN A BROWSER.
 *
 * Unit tests can assert that a handler ran; only a browser can answer the two
 * questions this issue is actually about, because both are about geometry and
 * defaults that happy-dom does not have:
 *
 *   • A file dropped on the EMPTY AIR of the deck — not on the 46px line in the
 *     middle of it — is attached, and the veil that says so covers the pane. The
 *     old target was the well alone, so the common aim missed and the browser's
 *     own default took the shell to the file.
 *   • The drop is CANCELLED. `dispatchEvent` returning false is the same signal
 *     the browser reads before deciding to navigate, so this is the assertion,
 *     not a proxy for it.
 *   • Launch closed asks the panel for the CLI; Launch with a prompt asks for
 *     chat. Recorded by the harness store (`__harnessPanelModes`) because the
 *     write is all the composer does — the panel itself lives in the shell.
 *
 * Drives harness/coldstart-entry.tsx: the SHIPPING composer and stylesheet with
 * only the store stubbed.
 *
 *   bunx vite --config apps/web/vite.coldstart.config.ts   # 55598
 *   bun apps/web/e2e/pod1669-verify.ts <outDir> [light|dark]
 */
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '.'
/** Both appearances, every run. The harness used to set NEITHER `data-theme`
 *  nor `.dark`, so its shots were shadcn's stock fallbacks — plausible-looking
 *  and wrong, which is the one failure a screenshot cannot report on itself. */
const THEME = process.argv[3] === 'dark' ? 'dark' : 'light'
const URL_ = `http://localhost:55598/coldstart-harness.html?first=0&theme=${THEME}`
const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
})
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const errs: string[] = []
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text().slice(0, 300))
})
page.on('pageerror', (e) => errs.push(`pageerror: ${String(e).slice(0, 400)}`))
const out: Record<string, unknown> = {}

/** Dispatch a real DragEvent carrying a real File, on the element at a point —
 *  `document.elementFromPoint` rather than a selector, so what is measured is
 *  what the operator's cursor would actually be over. */
async function dragAt(
  type: 'dragover' | 'drop',
  x: number,
  y: number,
): Promise<{ target: string; cancelled: boolean }> {
  return page.evaluate(
    ({ type, x, y }) => {
      const el = document.elementFromPoint(x, y)
      if (!el) throw new Error(`nothing at ${x},${y}`)
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'dropped.png', { type: 'image/png' }))
      const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true })
      const delivered = el.dispatchEvent(ev)
      return {
        target: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`,
        cancelled: !delivered,
      }
    },
    { type, x, y },
  )
}

await page.goto(URL_, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="cold-start-field"]')
await page.waitForTimeout(1200)

const wellBox = await page.locator('[data-testid="cold-start-field"]').boundingBox()
const deckBox = await page.locator('[data-testid="cold-start-deck"]').boundingBox()
if (!wellBox || !deckBox) throw new Error('no deck or well on screen')

// The point the drag is aimed at: high in the pane, well clear of the box. This
// is the aim that used to reach the DOCUMENT.
const x = Math.round(deckBox.x + deckBox.width / 2)
const y = Math.round(deckBox.y + 40)
out.pointIsOutsideTheWell = y < wellBox.y - 20
out.wellHeightClosed = Math.round(wellBox.height)
out.deckHeight = Math.round(deckBox.height)

// ── 1. the veil answers a drag over the empty air ───────────────────────────
const over = await dragAt('dragover', x, y)
out.dragOverTarget = over.target
out.dragOverCancelled = over.cancelled
await page.getByText('Drop files to attach').waitFor({ state: 'visible' })
const veil = await page.locator('text=Drop files to attach').boundingBox()
// The veil has to cover the PANE, not the line: same area as the question.
out.veilCoversDeck = await page.evaluate(() => {
  const frame = document.querySelector('.cold-start > .pointer-events-none') as HTMLElement | null
  const deck = document.querySelector('[data-testid="cold-start-deck"]') as HTMLElement
  if (!frame) return false
  const f = frame.getBoundingClientRect()
  const d = deck.getBoundingClientRect()
  return f.height > d.height * 0.9 && f.width > d.width * 0.9
})
out.veilLabelOnScreen = Boolean(veil)
await page.screenshot({ path: `${OUT}/pod1669-1-drop-veil-${THEME}.png` })

// ── 2. the drop lands, and is cancelled ─────────────────────────────────────
const dropped = await dragAt('drop', x, y)
out.dropTarget = dropped.target
out.dropCancelled = dropped.cancelled
await page.getByText('dropped.png').waitFor({ state: 'visible' })
out.chipShown = true
// An attachment unfolds the box — the strip lives inside the well.
out.expandedAfterDrop = await page
  .locator('[data-testid="cold-start-field"]')
  .getAttribute('data-expanded')
out.veilGoneAfterDrop = (await page.getByText('Drop files to attach').count()) === 0
await page.screenshot({ path: `${OUT}/pod1669-2-attached-${THEME}.png` })

// ── 3. a promptless Launch asks for the CLI ─────────────────────────────────
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="cold-start-field"]')
await page.waitForTimeout(1200)
out.closedBeforeLaunch = await page
  .locator('[data-testid="cold-start-field"]')
  .getAttribute('data-expanded')
await page.locator('[data-testid="cold-start-launch"]').click()
await page.waitForTimeout(400)
out.panelModeFromClosedLaunch = await page.evaluate(
  () => (globalThis as { __harnessPanelModes?: unknown[] }).__harnessPanelModes,
)

// ── 4. a written prompt asks for the chat ───────────────────────────────────
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="cold-start-field"]')
await page.waitForTimeout(1200)
await page.locator('.cold-start-input').click()
await page.locator('.cold-start-input').fill('Fix the flaky screening test')
await page.locator('[data-testid="cold-start-launch"]').click()
await page.waitForTimeout(1500)
out.panelModeFromWrittenLaunch = await page.evaluate(
  () => (globalThis as { __harnessPanelModes?: unknown[] }).__harnessPanelModes,
)
await page.screenshot({ path: `${OUT}/pod1669-3-launched-${THEME}.png` })

out.consoleErrors = errs
await browser.close()
console.log(JSON.stringify(out, null, 2))

/* Every line above is an assertion as well as a reading: a run that prints
 * plausible numbers for a composer that lost one of these behaviours would be
 * worse than no run at all. Verified by taking each half back out — the drop
 * removal times out on the veil, the mode removal empties both arrays. */
const expect = (name: string, ok: boolean): void => {
  if (!ok) throw new Error(`POD-1669 ${name}: ${JSON.stringify(out[name])}`)
}
expect('pointIsOutsideTheWell', out.pointIsOutsideTheWell === true)
expect('dragOverCancelled', out.dragOverCancelled === true)
expect('dropCancelled', out.dropCancelled === true)
expect('veilCoversDeck', out.veilCoversDeck === true)
expect('expandedAfterDrop', out.expandedAfterDrop === 'true')
expect('veilGoneAfterDrop', out.veilGoneAfterDrop === true)
expect('closedBeforeLaunch', out.closedBeforeLaunch === 'false')
expect(
  'panelModeFromClosedLaunch',
  JSON.stringify(out.panelModeFromClosedLaunch) ===
    JSON.stringify([{ sessionId: 'session-harness', mode: 'native' }]),
)
expect(
  'panelModeFromWrittenLaunch',
  JSON.stringify(out.panelModeFromWrittenLaunch) ===
    JSON.stringify([{ sessionId: 'session-harness', mode: 'chat' }]),
)
expect('consoleErrors', errs.length === 0)
