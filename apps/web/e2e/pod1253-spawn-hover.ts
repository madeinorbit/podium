/**
 * POD-1253: the spawn control's hover, measured as PAINTED PIXELS.
 *
 * `data-pressable`'s hover is `filter: brightness(1.08)`, which can only
 * brighten — and the artboard's chip rests on `#ffffff` in every light preset,
 * where that is a literal no-op. Computed style cannot see this: it reports the
 * background it was given whether or not the filter cancelled it. So this reads
 * the actual pixel out of a screenshot, at rest and on hover, in both modes.
 *
 * The dark run is the positive control: if the light delta is 0 AND the dark
 * delta is 0, the rig is not hovering anything and the light result means
 * nothing.
 *
 *   bun apps/web/e2e/pod1253-spawn-hover.ts [origin]
 */
import { chromium } from 'playwright'

const ORIGIN = process.argv[2] ?? 'http://localhost:55597'
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage()

/** The mean RGB of the chip's interior, away from its rim and its glyphs. */
async function chipPixel(): Promise<[number, number, number]> {
  // `.first()`: the block holds two buttons — the chip and the chevron's own
  // hitbox — and an ambiguous locator here reads as "element never appeared".
  const btn = page.locator('[data-testid="new-agent-button"] button').first()
  const box = await btn.boundingBox()
  if (!box) throw new Error('no button')
  const shot = await page.screenshot({
    clip: { x: box.x + box.width - 60, y: box.y + 12, width: 24, height: 14 },
  })
  const { PNG } = await import('pngjs')
  const png = PNG.sync.read(shot)
  let r = 0
  let g = 0
  let b = 0
  const n = png.width * png.height
  for (let i = 0; i < n; i++) {
    r += png.data[i * 4]
    g += png.data[i * 4 + 1]
    b += png.data[i * 4 + 2]
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

for (const mode of ['light', 'dark'] as const) {
  await page.goto(`${ORIGIN}/sidebar-harness.html?rows=8&mode=${mode}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForSelector('[data-testid="work-scroll"]')
  await page.waitForTimeout(1800)
  await page.mouse.move(5, 800)
  await page.waitForTimeout(300)
  const rest = await chipPixel()
  await page.locator('[data-testid="new-agent-button"] button').first().hover()
  await page.waitForTimeout(350)
  const hover = await chipPixel()
  const delta = rest.map((v, i) => hover[i] - v)
  console.log(
    `${mode.padEnd(5)} rest=rgb(${rest})  hover=rgb(${hover})  delta=${JSON.stringify(delta)}`,
  )
}
await browser.close()
