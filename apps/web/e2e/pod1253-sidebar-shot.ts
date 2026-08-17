/**
 * POD-1253: one screenshot of the work sidebar column, from whichever build is
 * behind the origin — so the live instance (main) and this branch's dev server
 * can be shot with the same script, same account, same rows, and the pair is a
 * real before/after rather than two different pictures.
 *
 *   PODIUM_SESSION_COOKIE=… bun apps/web/e2e/pod1253-sidebar-shot.ts <outDir> <origin> <label>
 */
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/pod1253'
const ORIGIN = process.argv[3] ?? 'http://127.0.0.1:55741'
const LABEL = process.argv[4] ?? 'sidebar'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1500, height: 1000 },
  deviceScaleFactor: 2,
})
if (COOKIE) {
  await ctx.addCookies([
    { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/', secure: false },
  ])
}
const page = await ctx.newPage()
page.setDefaultTimeout(120_000)
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 180_000 })
await page.waitForSelector('[data-testid="work-scroll"]', { timeout: 180_000 })
await page.waitForTimeout(6000)

const column = page.locator('[data-testid="work-scroll"]').locator('xpath=..')
for (const mode of ['dark', 'light'] as const) {
  await page.evaluate((m) => {
    document.documentElement.classList.toggle('dark', m === 'dark')
  }, mode)
  await page.waitForTimeout(700)
  await column.screenshot({ path: `${OUT}/${LABEL}-${mode}.png` })
  console.log(`${LABEL}-${mode}.png`)
}
await browser.close()
