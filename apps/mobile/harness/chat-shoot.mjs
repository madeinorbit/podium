// Screenshots the chat harness (POD-2380): node harness/chat-shoot.mjs <outdir>
import { chromium } from '@playwright/test'

const out = process.argv[2]
const browser = await chromium.launch({ executablePath: process.env.PW_EXEC })
for (const [name, q] of [
  ['chat-dark', ''],
  ['chat-reply-dark', '?reply=1'],
]) {
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`http://localhost:8198/chat-harness.html${q}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  if (q) {
    const ask = page.getByLabel(/Open note from POD-1906: asked you/)
    if (await ask.count()) await ask.click()
    await page.waitForTimeout(400)
  }
  await page.screenshot({ path: `${out}/${name}.png` })
  console.log(name, errs.slice(0, 3).join(' | '))
  await page.close()
}
await browser.close()
