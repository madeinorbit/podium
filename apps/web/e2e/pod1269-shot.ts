/**
 * POD-1269 evidence shots: the task inspector's needs-you controls, before and
 * after, driven against a real Podium instance.
 *
 * P1269_ORIGIN picks which build answers: the live service on 18787 is main
 * (the "before"), the worktree's own vite dev server is this branch (the
 * "after"). Both talk to the same API, so the same task is on screen in both.
 */
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const ORIGIN = process.env.P1269_ORIGIN ?? 'http://127.0.0.1:55621'
const OUT = process.env.P1269_OUT ?? 'shot'
const REF = process.env.P1269_REF ?? 'POD-1265'

const home = process.env.HOME ?? ''
const token = JSON.parse(readFileSync(home + '/.podium/cli-session.json', 'utf8')).token

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
await context.addCookies([
  { name: 'podium_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true },
])
const page = await context.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200))
})
await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)

// The dock's Tasks panel is open by default on this profile.
await page.waitForSelector('[data-testid="explorer-list"]', { timeout: 30000 })
await page.waitForTimeout(1200)

// A task outside the default "Needs you" tab (a closed one, say) is reached
// through the explorer's own search rather than by switching tabs.
if (process.env.P1269_SEARCH) {
  await page
    .getByPlaceholder(/Search/)
    .first()
    .fill(REF)
  await page.waitForTimeout(1200)
}
const row = page.locator('[data-testid="explorer-row"]').filter({ hasText: REF }).first()
await row.click()
await page.waitForSelector('[data-testid="dock-inspect-head"]', { timeout: 20000 })
await page.waitForTimeout(1500)

const dock = page.locator('[data-right-dock-panel="issue"]')
await dock.screenshot({ path: OUT + '.png' })
// The head alone: the ref line, the control strip and the decision band, which
// is where two of the three changes land and the one region a stale-build
// banner never covers.
await page.locator('[data-testid="dock-fixed"]').screenshot({ path: OUT + '-head.png' })

// ...and the roster, which is the other half of the change: scroll the dock's
// single scroller to the "Agents & sessions" heading and shoot again.
await page.evaluate(() => {
  const el = document.querySelector('[data-dock-scroll]')
  if (el) el.scrollTop = el.scrollHeight
})
await page.waitForTimeout(800)
await dock.screenshot({ path: OUT + '-roster.png' })
// The waiting session's row on its own — the third change, and the one a
// full-panel shot renders too small to read.
const waiting = page.locator('[data-testid="dock-session-row"]').first()
if (await waiting.count()) {
  await waiting.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await waiting.screenshot({ path: OUT + '-row.png' })
}
console.log('head:', (await page.locator('[data-testid="dock-inspect-head"]').innerText()).trim())
console.log('controls:', await page.locator('[data-testid="dock-fixed"] button').allInnerTexts())
console.log('session rows:', await page.locator('[data-testid="dock-session-row"]').allInnerTexts())
await browser.close()
