/**
 * Captures the composer harness (POD-1659). Run the harness first:
 *   npx vite --config vite.harness.config.ts
 * then `node harness/composer-shoot.mjs`.
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const PORT = process.env.HARNESS_PORT ?? '8091'
const OUT = new URL('../../../.design/POD-1659-composer/', import.meta.url)
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 900, height: 1600 },
  deviceScaleFactor: 3,
})
const problems = []
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
page.on('pageerror', (e) => problems.push(String(e)))
await page.goto(`http://localhost:${PORT}/harness/composer-harness.html`, {
  waitUntil: 'networkidle',
})
await page.waitForSelector('[data-testid="composer-bar"]')
await page.screenshot({ path: new URL('composer-ab.png', OUT).pathname, fullPage: true })

/**
 * THE POSITIVE CONTROL — the mechanical claim, not a height.
 *
 * "The stacked one is taller" is false (a grown prompt is SHORTER stacked), and
 * "placeholder length moves the resting height" stopped being true when
 * POD-1666 landed a measurement fix for that same symptom. What the restack
 * actually does is give the prose the capsule's FULL width instead of the strip
 * left between three 44pt targets — so the check is the field's own width, and
 * the grown case, which is where a wider field pays for the extra row.
 *
 * A rig drawing the same component in both columns reports a ratio of 1.0 and
 * fails here; that case is exercised by rendering OldComposer on both sides.
 */
const bars = page.locator('[data-testid="composer-bar"]')
const fields = page.locator('textarea')
const count = await bars.count()
const barHeights = []
const fieldWidths = []
for (let i = 0; i < count; i += 1) {
  barHeights.push((await bars.nth(i).boundingBox())?.height ?? 0)
  fieldWidths.push((await fields.nth(i).boundingBox())?.width ?? 0)
}
const pairs = []
for (let i = 0; i + 1 < count; i += 2) {
  pairs.push({
    before: barHeights[i],
    after: barHeights[i + 1],
    widen: fieldWidths[i + 1] / fieldWidths[i],
  })
}
const narrowest = Math.min(...pairs.map((p) => p.widen))
const grown = pairs[5]

console.log(`bars: ${count} (want 14)`)
console.log(
  pairs
    .map((p) => `${p.before.toFixed(0)}→${p.after.toFixed(0)}h ×${p.widen.toFixed(2)}w`)
    .join('  '),
)
console.log(
  `narrowest field gain: ×${narrowest.toFixed(2)} (want >1.2) · grown prompt shorter stacked: ${grown.after < grown.before}`,
)
if (problems.length) console.error('PAGE ERRORS:', problems.join(' | '))

const ok = count === 14 && narrowest > 1.2 && grown.after < grown.before && !problems.length
await browser.close()
process.exit(ok ? 0 : 1)
