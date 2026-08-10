/**
 * A single column, close up. Card geometry is decided in 1px steps, and a
 * whole-board screenshot downsampled to fit a review pane cannot show them.
 *
 * Usage: bun .artifacts/POD-634/zoom.mjs <label> [columnIndex]
 */
import { chromium } from '@playwright/test'

const label = process.argv[2] ?? 'before'
const which = Number(process.argv[3] ?? 3)
const ORIGIN = 'http://127.0.0.1:4318'

const auth = Bun.spawnSync(['podium', 'auth', 'mint-session', '--print-only', '--ttl', '15m'])
const token = new TextDecoder().decode(auth.stdout).trim()

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1728, height: 1000 },
  deviceScaleFactor: 3,
})
await context.addCookies([{ name: 'podium_session', value: token, url: ORIGIN }])
const page = await context.newPage()
await page.goto(`${ORIGIN}/issues?e2e=1`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="issue-column"]', { timeout: 60_000 })
await page.waitForTimeout(2500)

const column = page.locator('[data-testid="issue-column"]').nth(which)
await column.screenshot({ path: `.artifacts/POD-634/column-${label}.png` })

// The same column with the second card hovered — resting vs. hover is a 1px,
// few-percent delta that only reads side by side.
await page.locator('[data-issue-id]').nth(1).hover()
await page.waitForTimeout(400)
await page
  .locator('[data-testid="issue-column"]')
  .first()
  .screenshot({ path: `.artifacts/POD-634/column-${label}-hover.png` })

await browser.close()
console.log(`zoomed column ${which} as ${label}`)
