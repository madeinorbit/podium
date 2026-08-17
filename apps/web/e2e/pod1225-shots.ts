/**
 * POD-1225 verification shots: the onboarding agents screen and the ready
 * screen, against the stubbed-store harness.
 *
 *   cd apps/web && bunx vite --config vite.setup.config.ts
 *   bun apps/web/e2e/pod1225-shots.ts <outDir>
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1225_ORIGIN ?? 'http://localhost:55597'
const OUT = process.argv[2] ?? '/tmp/pod1225'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } })
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text())
})
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

for (const route of ['agent', 'first-task']) {
  await page.goto(`${ORIGIN}/setup-harness.html#${route}`)
  await page.reload()
  await page.waitForSelector('h1')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/${route}.png`, fullPage: true })
  console.log(route, await page.locator('h1').first().innerText())
  console.log(
    '  copy buttons:',
    await page.getByRole('button', { name: /^Copy$/ }).count(),
    '| "Needs one step":',
    await page.getByText('Needs one step').count(),
    '| "rest can wait":',
    await page.getByText(/rest can wait/).count(),
  )
}

await browser.close()
