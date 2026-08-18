import { chromium } from '@playwright/test'

const PAGE_URL = 'http://localhost:55571/newtask-harness.html'
// Shots land beside this script, the repo's convention for verification frames.
const OUT = new globalThis.URL('.', import.meta.url).pathname.replace(/\/$/, '')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1100, height: 860 }, deviceScaleFactor: 2 })
const failed: string[] = []
page.on('requestfailed', (r) => failed.push(r.url()))
page.on('console', (m) => {
  if (m.type() === 'error') failed.push(`console: ${m.text()}`)
})
await page.goto(PAGE_URL, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-slot="dialog-content"]')

// Prove Geist actually loaded — `document.fonts.check()` lies (it is true for
// any family name once a fallback exists).
const fontLoaded = await page.evaluate(() =>
  [...document.fonts].some((f) => /Geist/.test(f.family) && f.status === 'loaded'),
)

const card = page.locator('[data-slot="dialog-content"]')
await page.waitForTimeout(400)
await card.screenshot({ path: `${OUT}/pod1285-01-runs-on-band.png` })

// The band folded away.
await page.getByLabel('Title').click()
await page.keyboard.press('Alt+s')
await page.waitForTimeout(250)
await card.screenshot({ path: `${OUT}/pod1285-02-start-now-off.png` })
await page.keyboard.press('Alt+s')
await page.waitForTimeout(250)

// The machine menu, open, over the whole card.
await page.getByRole('button', { name: 'Machine' }).click()
await page.waitForTimeout(350)
await page.screenshot({ path: `${OUT}/pod1285-03-machine-menu.png` })
const menuRows = await page.getByRole('menuitem').allTextContents()
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// Filled in, with a Linear url pasted into the description.
await page.getByLabel('Title').fill('Runs-on band for the composer')
await page
  .getByLabel('Description')
  .fill('Follows the Claude design.\n\nhttps://linear.app/podium/issue/POD-412/new-task-redesign')
await page.waitForTimeout(300)
await card.screenshot({ path: `${OUT}/pod1285-04-filled.png` })

console.log('geist loaded:', fontLoaded)
console.log('machine rows:', JSON.stringify(menuRows))
console.log('failures:', JSON.stringify(failed))
await browser.close()
