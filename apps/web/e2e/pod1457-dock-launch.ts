/**
 * POD-1457 verification shots: the right dock's task panel, before and after.
 *
 * Drives `harness/dock-launch-entry.tsx`, which mounts the shipping
 * `IssueExplorer` in a 316px column against the real stylesheet. Point it at a
 * checkout of this branch for the after frames and at one of HEAD for the
 * before frames — the fixture travels with the entry file, so the two runs
 * differ in exactly one thing: what the panel offers to start work with.
 *
 * Both schemes, because the box is drawn out of `--well-floor` and
 * `--hairline-bar`, which are alphas over whatever surface they land on: one
 * value has to read as a recess on paper AND on ink.
 *
 *   cd apps/web && bunx vite --config vite.explorer-harness.config.ts
 *   bun apps/web/e2e/pod1457-dock-launch.ts <outDir> [before|after]
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1457_ORIGIN ?? 'http://localhost:55604'
const OUT = process.argv[2] ?? '/tmp/pod1457'
const STAMP = process.argv[3] ?? 'after'

const browser = await chromium.launch()

for (const scheme of ['dark', 'light'] as const) {
  const ctx = await browser.newContext({
    viewport: { width: 1060, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  })
  const page = await ctx.newPage()
  // The shell's theme is an explicit stored mode, not `prefers-color-scheme`
  // (app/theme.tsx defaults to dark), so the context's colorScheme alone would
  // draw two identical dark frames.
  await page.addInitScript((mode) => localStorage.setItem('podium.theme.mode', mode), scheme)
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[console] ${m.text().slice(0, 300)}`)
  })
  page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
  page.setDefaultTimeout(60_000)

  await page.goto(`${ORIGIN}/harness/dock-launch.html`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-case="plain"]')
  await page.waitForTimeout(800)

  for (const label of ['plain', 'discovered', 'running']) {
    const dock = page.locator(`[data-case="${label}"]`)
    await dock.screenshot({ path: `${OUT}/${STAMP}-${label}-${scheme}.png` })
    console.log(
      `${STAMP} ${scheme} ${label}:`,
      'launch box =',
      await dock.locator('[data-testid="launch-box"]').count(),
      '· start =',
      await dock.locator('[data-testid="task-primary-action"]').count(),
      '· fork =',
      await dock.locator('[data-testid="task-placement-trigger"]').count(),
    )
  }

  // WHICH AGENT, asked in the panel. The whole point of the change: this menu
  // did not exist on this surface, and reaching it meant leaving the explorer.
  const agent = page.locator('[data-case="plain"]').getByLabel('Agent')
  if ((await agent.count()) > 0) {
    await agent.click()
    await page.waitForTimeout(400)
    await page.screenshot({
      path: `${OUT}/${STAMP}-agent-menu-${scheme}.png`,
      clip: { x: 0, y: 0, width: 400, height: 680 },
    })
    console.log(`${STAMP} ${scheme} agent menu items:`, await page.getByRole('menuitem').count())
  }

  await ctx.close()
}

await browser.close()
