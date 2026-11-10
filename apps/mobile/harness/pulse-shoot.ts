import { chromium } from '@playwright/test'

const SP = process.argv[2]
const browser = await chromium.launch({ executablePath: process.env.PW_EXEC })
for (const [name, q, scheme] of [
  ['pulse-week-dark', '', 'dark'],
  ['pulse-5h-dark', '?range=fiveHour', 'dark'],
  ['pulse-cold-dark', '?state=cold', 'dark'],
]) {
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  await page.goto(`http://localhost:8197/pulse-harness.html${q}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SP}/${name}.png`, fullPage: true })
  console.log(name, errs.slice(0, 3).join(' | '))
  await page.close()
}
await browser.close()
