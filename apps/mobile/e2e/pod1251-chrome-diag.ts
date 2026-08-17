/** Chromium diagnostic against whatever origin serves the phone app (POD-1251). */
import { chromium } from 'playwright'

const [sessionId = '', label = 'diag'] = process.argv.slice(2)
const ORIGIN = process.env.P1251_ORIGIN ?? 'http://127.0.0.1:8123'
const COOKIE = process.env.PODIUM_SESSION_COOKIE ?? ''

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: process.env.P1251_SW === 'allow' ? 'allow' : 'block',
})
if (COOKIE) {
  await context.addCookies([
    { name: 'podium_session', value: COOKIE, domain: '127.0.0.1', path: '/' },
  ])
}
const page = await context.newPage()
page.on('console', (m) => console.log(`[console:${m.type()}]`, m.text().slice(0, 200)))
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
page.on('requestfailed', (r) =>
  console.log('[failed]', r.url().slice(0, 120), r.failure()?.errorText),
)
page.on('response', (r) => {
  if (r.status() >= 400) console.log('[http]', r.status(), r.url().slice(0, 140))
})
await page.goto(`${ORIGIN}/mobile/session/${sessionId}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(20000)
console.log('body:', (await page.evaluate(() => document.body.innerText)).slice(0, 400))
await page.screenshot({ path: `e2e/pod1251-chrome-${label}.png` })
await browser.close()
