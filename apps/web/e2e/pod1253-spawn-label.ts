/**
 * POD-1253: does the spawn control's label actually need the 5px that `pr-31`
 * takes out of the artboard's 36px right boundary (11px inset + 16px glyph +
 * the row's 9px gap)?
 *
 * Measures the label's natural width against the space each padding leaves, at
 * the column's default width and at its minimum — so the deviation is a decision
 * with a number behind it rather than a preference.
 *
 *   bun apps/web/e2e/pod1253-spawn-label.ts [origin]
 */
import { chromium } from 'playwright'

const ORIGIN = process.argv[2] ?? 'http://localhost:55597'
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage()

for (const width of [306, 260, 352]) {
  await page.goto(`${ORIGIN}/sidebar-harness.html?rows=8&width=${width}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForSelector('[data-testid="work-scroll"]')
  await page.waitForTimeout(1800)
  const out = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="new-agent-button"] button') as HTMLElement
    const label = btn.querySelector('span:not([aria-hidden])') as HTMLElement
    // The label's NATURAL width: clone it out of the truncating flex context.
    const probe = label.cloneNode(true) as HTMLElement
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;width:auto'
    document.body.appendChild(probe)
    const natural = probe.getBoundingClientRect().width
    probe.remove()
    const cs = getComputedStyle(btn)
    const inner =
      btn.getBoundingClientRect().width -
      Number.parseFloat(cs.paddingLeft) -
      Number.parseFloat(cs.paddingRight) -
      2 * Number.parseFloat(cs.borderLeftWidth)
    const swatch = 11 + 9 // swatch + gap
    return {
      text: (label.textContent ?? '').trim(),
      naturalPx: Math.round(natural),
      availableNow: Math.round(inner - swatch),
      // What the artboard's 36px right boundary would leave instead.
      availableAt36: Math.round(inner - swatch - (36 - Number.parseFloat(cs.paddingRight))),
      truncatedNow: label.scrollWidth > label.clientWidth + 1,
    }
  })
  console.log(`width=${width}`, JSON.stringify(out))
}
await browser.close()
