/**
 * POD-1859 verification shots: the Cost section, in the column it ships in.
 *
 * Drives `harness/cost-entry.tsx`, which mounts the shipping `IssuePanelView`
 * four times — one per state — against the real stylesheet with the explorer
 * harness's stubbed store answering `cost.task`. jsdom proves the branches; only
 * this shows whether they read as one section at dock width.
 *
 *   cd apps/web && bunx vite --config vite.explorer-harness.config.ts
 *   bun apps/web/e2e/pod1859-cost-shots.ts <outDir>
 */
import { chromium } from '@playwright/test'

// Vite binds ::1 here, and 127.0.0.1 is refused — see the harness config.
const ORIGIN = process.env.P1859_ORIGIN ?? 'http://[::1]:55604'
const OUT = process.argv[2] ?? '/tmp/pod1859'

const browser = await chromium.launch()
// The app's theme is localStorage-authoritative and defaults to dark, so
// `colorScheme` alone photographs the same frame twice — see app/theme.tsx.
const ctx = await browser.newContext({
  viewport: { width: 1740, height: 1000 },
  deviceScaleFactor: 2,
})
await ctx.addInitScript(
  ([k, m]) => localStorage.setItem(k as string, m as string),
  ['podium.theme.mode', process.env.P1859_THEME ?? 'dark'],
)
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
page.setDefaultTimeout(30_000)

await page.goto(`${ORIGIN}/harness/cost.html`, { waitUntil: 'networkidle' })
await page.waitForSelector('[data-testid="dock-cost"]')
await page.waitForTimeout(700)

// 1. CLOSED — four lines answering "what has this cost", four states across.
//    The roster above the first two carries the meta line that stops it lying by
//    omission: two agents listed, ten sessions accounted for.
console.log(
  'roster meta:',
  await page.locator('[data-testid="dock-sessions"] span').allTextContents(),
)
await page.screenshot({ path: `${OUT}/1-closed.png` })

// 2. OPEN — the only place in the app that lists every session that ever ran,
//    live ones keeping their mark and showing a figure like the rest.
await page.locator('[data-testid="cost-disclosure"]').first().click()
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/2-disclosure-open.png` })

for (const part of await page.locator('[data-testid="dock-cost"]').all()) {
  console.log('---\n', (await part.textContent())?.slice(0, 400))
}

await browser.close()
