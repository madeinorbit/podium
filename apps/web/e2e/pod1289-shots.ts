/**
 * POD-1289 evidence: the Git dock's commit rows unfold, and a file under one
 * opens the diff sheet reading out of that commit.
 *
 * Driven against an isolated from-source instance (see .claude/skills/verify).
 *   P1289_ORIGIN, P1289_TOKEN, P1289_WT, P1289_PANE, P1289_OUT
 */
import { chromium } from '@playwright/test'

const ORIGIN = process.env.P1289_ORIGIN ?? 'http://127.0.0.1:19321'
const TOKEN = process.env.P1289_TOKEN ?? ''
const WT = process.env.P1289_WT ?? ''
const PANE = process.env.P1289_PANE ?? ''
const OUT = process.env.P1289_OUT ?? 'pod1289'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
await ctx.addCookies([
  { name: 'podium_session', value: TOKEN, domain: '127.0.0.1', path: '/', httpOnly: true },
])
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text().slice(0, 240))
})
await page.goto(`${ORIGIN}/workspace?wt=${encodeURIComponent(WT)}&pane=${PANE}&e2e&gpu=off`, {
  waitUntil: 'domcontentloaded',
})
await page.waitForTimeout(6000)

// The dock's Git tab.
await page.locator('button[title="Git"]').first().click()
await page.waitForSelector('[data-testid="git-panel"]', { timeout: 30000 })
await page.waitForTimeout(2500)
const dock = page.locator('[data-testid="git-panel"]')
await dock.screenshot({ path: `${OUT}-1-folded.png` })

// Unfold the top commit row.
const rows = page.locator('[data-testid="git-panel"] [aria-expanded]')
console.log('commit rows:', await rows.count())
const first = rows.first()
console.log('row text:', (await first.innerText()).replace(/\n/g, ' | '))
await first.click()
await page.waitForTimeout(2500)
console.log('aria-expanded:', await first.getAttribute('aria-expanded'))
await dock.screenshot({ path: `${OUT}-2-unfolded.png` })

const files = page.locator('[data-testid^="commit-files-"] button')
console.log('files listed:', await files.count())
console.log('file rows:', (await files.allInnerTexts()).slice(0, 12))

// A file under the commit opens the sheet, reading from that commit.
await files.first().click()
await page.waitForSelector('[data-testid="diff-sheet"]', { timeout: 20000 })
await page.waitForTimeout(2500)
console.log('sheet title:', await page.locator('.diff-sheet-title').innerText())
console.log('rail:', (await page.locator('.diff-file').allInnerTexts()).slice(0, 8))
console.log('diff rows:', await page.locator('.diff-row').count())
console.log('refresh control present:', await page.getByTitle(/Re-read the working tree/).count())
await page.screenshot({ path: `${OUT}-3-sheet.png` })
await page.locator('.app-sheet-diff').screenshot({ path: `${OUT}-4-sheet-only.png` })
await browser.close()
