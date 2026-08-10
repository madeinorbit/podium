import { firefox } from '@playwright/test'

const token = process.env.PODIUM_BROWSER_TOKEN
if (!token) throw new Error('PODIUM_BROWSER_TOKEN is required')

const browser = await firefox.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
await context.addCookies([{ name: 'podium_session', value: token, url: 'http://localhost:18787' }])
const page = await context.newPage()
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    console.error(`[browser:${message.type()}] ${message.text()}`)
  }
})
page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`))
await page.addInitScript(() => localStorage.setItem('podium.panelMode', 'native'))
await page.goto('http://localhost:18787/?e2e=1', { waitUntil: 'domcontentloaded', timeout: 30_000 })
const started = Date.now()
await page.waitForFunction(() => document.querySelectorAll('button').length > 0, undefined, {
  timeout: 120_000,
})
const snapshot = await page.evaluate((navigationStarted) => ({
  title: document.title,
  url: location.href,
  readyMs: Date.now() - navigationStarted,
  text: document.body.innerText.slice(0, 2_000),
  buttons: [...document.querySelectorAll('button')]
    .map((button) => ({ text: button.textContent?.trim() ?? '', aria: button.getAttribute('aria-label') }))
    .filter((button) => button.text || button.aria)
    .slice(0, 120),
}), started)
console.log(JSON.stringify(snapshot, null, 2))
await browser.close()
