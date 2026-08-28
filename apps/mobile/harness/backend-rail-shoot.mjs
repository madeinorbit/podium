/**
 * Captures the backend-rail harness (POD-1677). Run the harness first:
 *   npx vite --config vite.harness.config.ts
 * then `node harness/backend-rail-shoot.mjs`.
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

const PORT = process.env.HARNESS_PORT ?? '8091'
const OUT = new URL('../../../.design/POD-1677-backend-rail/', import.meta.url)
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 1600 }, deviceScaleFactor: 3 })
const problems = []
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
page.on('pageerror', (e) => problems.push(String(e)))
await page.goto(`http://localhost:${PORT}/harness/backend-rail-harness.html`, {
  waitUntil: 'networkidle',
})
await page.waitForSelector('[data-testid="composer-bar"]')
await page.screenshot({ path: new URL('backend-rail-ab.png', OUT).pathname, fullPage: true })

/**
 * THE POSITIVE CONTROL — three mechanical claims, each of which a rig drawing
 * the same component in both columns would fail.
 *
 *  1. The rail moved INSIDE the capsule. Before, the chips were a sibling of
 *     the blurred surface; after, the surface contains them.
 *  2. The whole composer block got SHORTER by roughly the band it stopped
 *     stacking — measured on the DOCK, because the `below` rail hung outside
 *     the blurred capsule and never counted toward the capsule's own height.
 *     The capsule itself must NOT have grown: a 30pt chip in a row of 44pt
 *     targets is free.
 *  3. Nothing overflows. The chips share the control row with two fixed 44pt
 *     targets, so the test is the gap between the LAST CHIP and the mic — not
 *     the rail's own box, which flexbox shrinks obediently while its
 *     non-shrinking children spill straight over the controls. A chip that
 *     paints under the mic is exactly the failure this change could introduce,
 *     and only the chip's own right edge sees it.
 */
const bars = page.locator('[data-testid="composer-bar"]')
const docks = page.locator('[data-testid="composer-bar"] >> xpath=..')
const rails = page.locator('[data-testid="composer-backend"]')
const count = await bars.count()
const rows = []
for (let i = 0; i + 1 < count; i += 2) {
  const before = await docks.nth(i).boundingBox()
  const after = await docks.nth(i + 1).boundingBox()
  const capsuleBefore = await bars.nth(i).boundingBox()
  const capsuleAfter = await bars.nth(i + 1).boundingBox()
  const railBefore = await rails.nth(i).boundingBox()
  const railAfter = await rails.nth(i + 1).boundingBox()
  rows.push({
    before,
    after,
    capsuleGrew: capsuleAfter.height > capsuleBefore.height + 0.5,
    // The chip row lives inside the capsule's box now, and did not before.
    inside:
      railAfter.y >= capsuleAfter.y &&
      railAfter.y + railAfter.height <= capsuleAfter.y + capsuleAfter.height + 0.5 &&
      railAfter.x + railAfter.width <= capsuleAfter.x + capsuleAfter.width,
    wasOutside: railBefore.y >= capsuleBefore.y + capsuleBefore.height - 0.5,
    // One line of chips, not two. The pill's own min-height is 30.
    oneLine: railAfter.height <= 34,
  })
}

// The send disc must still land inside the capsule, and no chip may reach the
// mic's target, on every after-frame.
const sends = page.getByRole('button', { name: 'Send' })
const mics = page.getByRole('button', { name: 'Start dictation' })
const modelChips = page.getByRole('button', { name: 'Model' })
const effortChips = page.getByRole('button', { name: 'Effort' })
let sendFits = true
let clears = true
let tightest = Infinity
for (let i = 1; i < count; i += 2) {
  const send = await sends.nth(i).boundingBox()
  const bar = await bars.nth(i).boundingBox()
  if (send.x + send.width > bar.x + bar.width + 0.5) sendFits = false
  if (send.y + send.height > bar.y + bar.height + 0.5) sendFits = false

  const mic = await mics.nth(i).boundingBox()
  const chips = [await modelChips.nth(i).boundingBox()]
  if ((await effortChips.count()) > i) chips.push(await effortChips.nth(i).boundingBox())
  for (const chip of chips) {
    if (!chip) continue
    const gap = mic.x - (chip.x + chip.width)
    if (gap < tightest) tightest = gap
    // Not just non-overlapping: the leading slot keeps a hair of air off the
    // trailing target even when a truncated chip is at its floor.
    if (gap < 6) clears = false
  }
}

const shorter = rows.filter((r) => r.after.height < r.before.height).length
const inside = rows.every((r) => r.inside && r.wasOutside)
const oneLine = rows.every((r) => r.oneLine)
const grew = rows.filter((r) => r.capsuleGrew).length

console.log(`pairs: ${rows.length} (want 8)`)
console.log(
  rows.map((r) => `${r.before.height.toFixed(0)}→${r.after.height.toFixed(0)}h`).join('  '),
)
console.log(
  `rail moved into the capsule: ${inside} · chips on one line: ${oneLine} · send still fits: ${sendFits} · dock shorter: ${shorter}/${rows.length} · capsule grew: ${grew}/${rows.length} (want 0)`,
)
console.log(`tightest chip-to-mic gap: ${tightest.toFixed(1)}px (want >= 6) · clears: ${clears}`)
if (problems.length) console.error('PAGE ERRORS:', problems.join(' | '))

const ok =
  rows.length === 8 &&
  inside &&
  oneLine &&
  sendFits &&
  clears &&
  shorter === rows.length &&
  grew === 0 &&
  problems.length === 0
await browser.close()
process.exit(ok ? 0 : 1)
