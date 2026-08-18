/**
 * POD-1277 verification shots: the dock column pointed at an archived task,
 * before and after.
 *
 * Drives the harness (`harness/explorer-entry.tsx`), which mounts the shipping
 * `IssueExplorer` against the real stylesheet with a stubbed store, so the two
 * frames differ in exactly one thing: which panel the level renders.
 *
 *   cd apps/web && bunx vite --config vite.explorer-harness.config.ts
 *   bun apps/web/e2e/pod1277-explorer-shots.ts <outDir>
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1277_ORIGIN ?? 'http://127.0.0.1:55604'
const OUT = process.argv[2] ?? '/tmp/pod1277'

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 360, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console] ${m.text().slice(0, 300)}`)
})
page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
page.setDefaultTimeout(60_000)

await page.goto(`${ORIGIN}/harness/explorer.html`, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-right-dock-panel="issue"]')
await page.waitForTimeout(700)

const dock = page.locator('[data-right-dock-panel="issue"]')

await page.evaluate(() => window.probe.legacy(true))
await page.waitForTimeout(300)
await dock.screenshot({ path: `${OUT}/before-intake-dock.png` })
console.log('before:', (await dock.textContent())?.slice(0, 120))

await page.evaluate(() => window.probe.legacy(false))
await page.waitForTimeout(400)
await dock.screenshot({ path: `${OUT}/after-archived-task.png` })
console.log('after:', (await dock.textContent())?.slice(0, 120))

// The trail says where the panel is, and the panel now agrees with it.
console.log('crumbs:', await page.locator('[data-testid="explorer-crumbs"]').textContent())
console.log('intake present:', await page.locator('[data-testid="dock-intake"]').count())

// And when the task stops existing under the operator, the level goes home:
// the trail collapses to the root and the panel is the index, not a placeholder.
await page.evaluate(() => window.probe.vanish())
await page.waitForTimeout(500)
await dock.screenshot({ path: `${OUT}/after-task-gone-index.png` })
console.log('gone crumbs:', await page.locator('[data-testid="explorer-crumbs"]').textContent())
console.log('gone list:', await page.locator('[data-testid="explorer-list"]').count())

await browser.close()
