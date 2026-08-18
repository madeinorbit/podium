/**
 * POD-1320 — shoot the two mobile-handoff surfaces from the harness dev server
 * (`bun x vite --config apps/web/vite.mobile-promo.config.ts`), light and dark,
 * chip closed and sheet open.
 *
 *   bun run apps/web/e2e/pod1320-shot.ts <out-prefix>
 */
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/pod1320'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:55601/harness/mobile-promo.html', { waitUntil: 'networkidle' })
await page.waitForSelector('[data-testid="mobile-promo-card"]')

for (const theme of ['light', 'dark'] as const) {
  await page.evaluate((mode) => {
    document.documentElement.classList.toggle('dark', mode === 'dark')
  }, theme)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}-${theme}-closed.png`, fullPage: true })
  await page.click('[data-testid="mobile-handoff-chip"]')
  await page.waitForSelector('[data-testid="mobile-handoff-sheet"]')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}-${theme}-open.png`, fullPage: true })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}
await browser.close()
console.log('ok')
