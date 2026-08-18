/**
 * THE SPAWN MENU'S SIGNED-OUT ROW, BEFORE AND AFTER (POD-1322).
 *
 * Drives `harness/spawn-menu.html` — the shipping `NewAgentMenu` over this
 * host's real inventory. Pass a name on argv to label the frame, so the same
 * script can shoot the old treatment (amber ink, no hint) and the new one
 * (normal ink, `signed out` in the hint column) for comparison:
 *
 *   bunx vite --config vite.harness.config.ts       # port 55599
 *   bun e2e/pod1322-spawn-menu-shots.ts after
 */
import { chromium } from '@playwright/test'

const PAGE_URL = 'http://localhost:55599/harness/spawn-menu.html'
const NAME = process.argv[2] ?? 'after'
// Shots land beside this script, the repo's convention for verification frames.
const OUT = new globalThis.URL('.', import.meta.url).pathname.replace(/\/$/, '')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 520, height: 460 }, deviceScaleFactor: 2 })
const failed: string[] = []
page.on('requestfailed', (r) => failed.push(r.url()))
page.on('console', (m) => {
  if (m.type() === 'error') failed.push(`console: ${m.text()}`)
})
await page.goto(PAGE_URL, { waitUntil: 'networkidle' })
// The popup is a `popover` element: it paints only once its trigger opens it.
await page.getByRole('button', { name: /New Claude in podium/ }).click()
await page.waitForSelector('[role="menu"]')
await page.waitForTimeout(400)

const menu = page.locator('[data-slot="dropdown-menu-content"]').first()
await menu.screenshot({ path: `${OUT}/pod1322-${NAME}.png` })

// The reading the shot is evidence FOR, in text: which rows carry words, and
// whether the signed-out one is still clickable.
const rows = await page.getByRole('menuitem').all()
for (const row of rows) {
  const text = (await row.textContent())?.replace(/\s+/g, ' ').trim()
  const disabled = await row.getAttribute('data-refused')
  const cls = (await row.getAttribute('class')) ?? ''
  console.log(
    `${text?.padEnd(30)} refused=${disabled ?? 'no'} warning-ink=${cls.includes('text-warning')}`,
  )
}
if (failed.length) console.log('FAILED REQUESTS', failed)
await browser.close()
