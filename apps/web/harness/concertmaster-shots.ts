// bun harness/concertmaster-shots.ts <outDir>   (HARNESS_URL, default http://localhost:55599)
import { chromium } from '@playwright/test'

const out = process.argv[2] ?? '/tmp/concertmaster-shots'
const base = process.env.HARNESS_URL ?? 'http://localhost:55599'
const browser = await chromium.launch()
for (const [name, query, width] of [
  ['chat-dark', 'theme=dark&view=chat&width=760', 760],
  ['chat-light', 'theme=light&view=chat&width=760', 760],
  ['chat-narrow-dark', 'theme=dark&view=chat&width=390', 390],
  ['dock-dark', 'theme=dark&view=dock&width=360', 360],
  ['dock-light', 'theme=light&view=dock&width=360', 360],
] as const) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 })
  await page.goto(`${base}/harness/concertmaster.html?${query}`)
  await page.waitForSelector('[data-testid="scene"]')
  await page.waitForTimeout(400)
  await page.locator('main').screenshot({ path: `${out}/${name}.png` })
  await page.close()
}
await browser.close()
console.log(`shots in ${out}`)
