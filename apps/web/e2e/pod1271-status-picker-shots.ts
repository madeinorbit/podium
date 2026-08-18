/**
 * POD-1271 verification: the status glyph on a list row opens its own menu, and
 * the row underneath it stays shut.
 *
 * Drives `harness/status-picker-entry.tsx`, which mounts the shipping
 * `IssueListView` against the real stylesheet, so the frames show the menu the
 * operator gets rather than a test double of it.
 *
 *   cd apps/web && bunx vite --config vite.harness.config.ts
 *   bun apps/web/e2e/pod1271-status-picker-shots.ts <outDir>
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1271_ORIGIN ?? 'http://127.0.0.1:55599'
const OUT = process.argv[2] ?? new URL('.', import.meta.url).pathname

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 900, height: 460 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console] ${m.text().slice(0, 300)}`)
})
page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
page.setDefaultTimeout(30_000)

await page.goto(`${ORIGIN}/harness/status-picker.html`, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-testid="issues-list"]')
await page.waitForTimeout(400)

await page.screenshot({ path: `${OUT}/pod1271-rows-closed.png` })

// The mark on the first row is the door.
const glyph = page.locator('[data-testid="issue-status-picker"]').first()
await glyph.hover()
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/pod1271-glyph-hover.png` })

await glyph.click()
await page.waitForSelector('[role="menu"]')
await page.waitForTimeout(250)
await page.screenshot({ path: `${OUT}/pod1271-menu-open.png` })

await page.getByRole('menuitem', { name: 'Review' }).click()
await page.waitForTimeout(250)
console.log('picks:', await page.evaluate(() => window.probe.picks))
console.log('rows opened:', await page.evaluate(() => window.probe.opens))
await page.screenshot({ path: `${OUT}/pod1271-after-pick.png` })

// Clicking the row itself still opens the task — the glyph took a click out of
// the row, it did not take the row out of service.
await page.locator('[data-issue-id="i-1250"]').click()
console.log('rows opened after row click:', await page.evaluate(() => window.probe.opens))

// Keyboard: the trigger is a span, so Base UI's non-native button path is what
// makes Enter open it at all.
await page.keyboard.press('Escape')
await glyph.focus()
await page.keyboard.press('Enter')
await page.waitForTimeout(250)
console.log('menu open by keyboard:', await page.locator('[role="menu"]').count())
await page.screenshot({ path: `${OUT}/pod1271-menu-keyboard.png` })

await browser.close()
