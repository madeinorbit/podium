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
 * THE POSITIVE CONTROL — and it is NOT "the new one is taller".
 *
 * The defect was that the composer's resting height depended on how long its
 * PLACEHOLDER was: the flanked layout left the prose a narrow column, so
 * "Message — resumes the agent…" wrapped to two lines and opened the capsule
 * taller than "Message the agent…" did, before anything was typed. The first
 * three pairs are exactly those three placeholders, so the claim to check is
 * that the AFTER column is one height for all three while the BEFORE column is
 * not — a rig that drew the same component twice would report both uniform and
 * be caught here.
 *
 * The grown pair is the counter-example that keeps the check honest: stacked is
 * SHORTER there, because a full-width field spends fewer lines on the same
 * prompt than a flanked one does. Asserting "taller" everywhere would have
 * failed on the one case that matters most.
 */
const bars = page.locator('[data-testid="composer-bar"]')
const count = await bars.count()
const heights = []
for (let i = 0; i < count; i += 1) heights.push((await bars.nth(i).boundingBox())?.height ?? 0)
const pairs = []
for (let i = 0; i + 1 < count; i += 2) pairs.push([heights[i], heights[i + 1]])
const placeholderOnly = pairs.slice(0, 3)
const uniform = (values) => new Set(values.map((v) => v.toFixed(0))).size === 1
const beforeVaries = !uniform(placeholderOnly.map(([before]) => before))
const afterUniform = uniform(placeholderOnly.map(([, after]) => after))
const grownIsShorter = pairs[5][1] < pairs[5][0]

console.log(`bars: ${count} (want 14)`)
console.log(pairs.map(([b, a]) => `${b.toFixed(0)}→${a.toFixed(0)}`).join('  '))
console.log(
  `placeholder length moves BEFORE: ${beforeVaries} · leaves AFTER flat: ${afterUniform} · grown prompt is shorter stacked: ${grownIsShorter}`,
)
if (problems.length) console.error('PAGE ERRORS:', problems.join(' | '))

const ok = count === 14 && beforeVaries && afterUniform && grownIsShorter && !problems.length
await browser.close()
process.exit(ok ? 0 : 1)
