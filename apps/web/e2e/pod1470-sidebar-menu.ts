/**
 * POD-1470 verification shots: the sidebar row's right-click menu.
 *
 * Drives `harness/sidebar-entry.tsx`, which mounts the shipping
 * `SidebarUnified` — real rows, real menu, real stylesheet — over a stubbed
 * store. Run it once on this branch and once with the two menu sources checked
 * out at HEAD~1 for the before frame; the fixture is the harness's, so the two
 * runs differ in exactly one thing: what the menu offers.
 *
 *   cd apps/web && bunx vite --config vite.sidebar.config.ts
 *   bun apps/web/e2e/pod1470-sidebar-menu.ts <outDir> [before|after]
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1470_ORIGIN ?? 'http://localhost:55597'
const OUT = process.argv[2] ?? '/tmp/pod1470'
const STAMP = process.argv[3] ?? 'after'

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 720, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
const page = await ctx.newPage()
await page.addInitScript(() => localStorage.setItem('podium.theme.mode', 'dark'))
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console] ${m.text().slice(0, 300)}`)
})
page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
page.setDefaultTimeout(30_000)

// BOTH CASES, because one entry has two faces. An unstarted task's menu reads
// "Run now"; a task with a worktree — the ordinary state of everything in a
// working column — read "Assign agent" until POD-1470.
for (const [state, query] of [
  ['running', 'rows=8&started=1'],
  ['unstarted', 'rows=8'],
] as const) {
  await page.goto(`${ORIGIN}/sidebar-harness.html?${query}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  // The first row of the project group — an ordinary task, which is what the
  // operator right-clicks.
  const row = page.locator('[data-testid="project-group-rows"] > div').first()
  const box = await row.boundingBox()
  if (!box) throw new Error('no sidebar row to right-click')
  await page.mouse.click(box.x + 80, box.y + box.height / 2, { button: 'right' })

  const menu = page.locator('[role="menu"][aria-label="Task actions"]')
  await menu.waitFor()
  await page.waitForTimeout(300)

  const items = await menu.locator('[role="menuitem"]').allInnerTexts()
  console.log(`${STAMP} · ${state}:`)
  for (const item of items) console.log(`  · ${item.replace(/\s+/g, ' ').trim()}`)

  await menu.screenshot({ path: `${OUT}/${STAMP}-${state}-menu.png` })
}
await browser.close()
