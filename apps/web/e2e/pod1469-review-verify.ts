/**
 * POD-1469 REVIEW PASS — the behaviour the fixes are about, in a browser.
 *
 * The two shot scripts beside this one are about geometry. This one is about
 * what the box and the column DO, and it drives both harnesses in one pass
 * because the review's findings straddle them:
 *
 *   • the fold's two heights, and Launch meaning two different things across it
 *   • whitespace is not a prompt on either side of that fold
 *   • the draft key written from OUTSIDE reaches a composer that is already
 *     mounted — the seeded-`useState` bug, reproduced the way `New task` causes
 *     it (`__harnessUi` on the coldstart stub is that outside writer)
 *   • the empty project's band and its row-shaped door, and that a filter takes
 *     both away
 *   • `Add repository` gives up its words on the COLUMN's width, with the
 *     viewport left wide — which is the whole point of the container query
 *
 * The live app is the better subject and was tried first; a first sync on this
 * host never completes in a fresh browser profile (the feed backlog resyncs in
 * a loop, on main's build too), so the harnesses are what can be driven here.
 *
 *   bunx vite --config apps/web/vite.coldstart.config.ts   # 55598
 *   bunx vite --config apps/web/vite.sidebar.config.ts     # 55597
 *   bun apps/web/e2e/pod1469-review-verify.ts <outDir>
 */
import { chromium } from 'playwright'

const OUT = process.argv[2]
const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
})
const page = await ctx.newPage()
page.setDefaultTimeout(30_000)
const errs: string[] = []
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text().slice(0, 300))
})
page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 400)))
const out: Record<string, unknown> = {}

// ── COMPOSER ────────────────────────────────────────────────────────────────
await page.goto('http://localhost:55598/coldstart-harness.html?first=0', {
  waitUntil: 'domcontentloaded',
})
await page.waitForSelector('[data-testid="cold-start-field"]')
await page.waitForTimeout(1200)

const boxH = () =>
  page.evaluate(() =>
    Math.round(
      (document.querySelector('.cold-start-input') as HTMLElement).getBoundingClientRect().height,
    ),
  )
const expanded = () =>
  page.locator('[data-testid="cold-start-field"]').getAttribute('data-expanded')
const field = page.locator('.cold-start-input')
const launch = page.locator('[data-testid="cold-start-launch"]')

out.closedHeight = await boxH()
out.closedExpanded = await expanded()
out.launchLiveClosed = await launch.isEnabled()
out.chipLabel = (await page.getByRole('button', { name: 'Agent' }).innerText())
  .replace(/\s+/g, ' ')
  .trim()
out.chipHasGlyph = await page.evaluate(() => {
  const chip = document.querySelector('button[aria-label="Agent"]')
  return chip?.querySelector('svg') !== null && chip?.querySelector('.bg-claude') === null
})
await page.screenshot({ path: `${OUT}/c1-closed.png` })

await field.click()
await page.waitForTimeout(60)
out.midFoldHeight = await boxH()
await page.waitForTimeout(500)
out.openHeight = await boxH()
out.launchRefusedWhenEmpty = !(await launch.isEnabled())
await page.screenshot({ path: `${OUT}/c2-open-empty.png` })

// Whitespace is not a prompt, on either side of the fold.
await field.fill('   ')
await page.waitForTimeout(200)
out.launchRefusedForSpaces = !(await launch.isEnabled())
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
out.escapeClosedTheSpaces = (await expanded()) === 'false'

await field.click()
await field.fill(
  'Rework the flight deck header so a mission with twelve sessions still reads at a glance.',
)
await page.waitForTimeout(300)
out.launchLiveWhenTyped = await launch.isEnabled()
await page.screenshot({ path: `${OUT}/c3-open-typed.png` })

// The seed a sidebar button writes reaches a MOUNTED composer.
await page.evaluate(() => {
  const w = globalThis as { __harnessUi?: { set: (k: string, v: string | null) => void } }
  w.__harnessUi?.set(
    'podium.firstTaskActivation.draft',
    JSON.stringify({
      repoPath: '/home/podium/podium',
      machineId: 'machine-a',
      agent: 'claude-code',
      title: '',
    }),
  )
})
await page.waitForTimeout(600)
out.seedClearedTheProse = (await field.inputValue()) === ''
out.seedLeftTheBoxOpen = (await expanded()) === 'true'
await page.screenshot({ path: `${OUT}/c4-after-seed.png` })

// The X is a way out; a retry in flight has none.
await field.click()
await field.fill('Half a thought')
await page.waitForTimeout(300)
out.closeOfferedWhenOpen = (await page.locator('[data-testid="cold-start-collapse"]').count()) === 1
await page.locator('[data-testid="cold-start-collapse"]').click()
await page.waitForTimeout(500)
out.xClearsAndRefolds = (await field.inputValue()) === '' && (await expanded()) === 'false'

for (const mode of ['light', 'dark'] as const) {
  await page.evaluate((m) => document.documentElement.classList.toggle('dark', m === 'dark'), mode)
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/c5-${mode}.png` })
}

// ── SIDEBAR ─────────────────────────────────────────────────────────────────
await page.goto('http://localhost:55597/sidebar-harness.html', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="new-task-button"]')
await page.waitForTimeout(1000)

out.newTaskRow = (await page.locator('[data-testid="new-task-button"]').innerText())
  .replace(/\s+/g, ' ')
  .trim()
out.addRepoOnFilterLine = (await page.locator('[data-testid="add-repository"]').count()) === 1
out.noFooterToolsRow = (await page.getByRole('button', { name: 'Search' }).count()) === 0
const bands = await page.locator('[data-testid="project-group-label"]').allTextContents()
out.bands = bands.map((b) => b.replace(/\s+/g, ' ').trim())
out.startFirstTaskRows = await page.locator('[data-testid="start-first-task"]').count()
await page.screenshot({ path: `${OUT}/s1-column.png` })

const labelShown = () =>
  page.evaluate(() => {
    const l = document.querySelector('.worklist-add-repo-label')
    return l !== null && getComputedStyle(l).display !== 'none'
  })
const setColumn = (w: number) =>
  page.evaluate((px) => {
    const el = document.querySelector('[data-testid="sidebar-harness"]') as HTMLElement | null
    if (el) el.style.width = `${px}px`
  }, w)

out.addRepoWordsAt306 = await labelShown()
await setColumn(200)
await page.waitForTimeout(400)
out.addRepoWordsAt200 = await labelShown()
await page.screenshot({ path: `${OUT}/s2-narrow.png` })
await setColumn(306)
await page.waitForTimeout(400)
out.addRepoWordsBack = await labelShown()

// The empty project's door, hovered — it is a row-shaped hole that lifts.
await page.locator('[data-testid="start-first-task"]').first().hover()
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/s3-first-task-hover.png` })

// A filter takes the empty band out with it.
await page.locator('[data-testid="work-search-input"]').fill('zzz-no-such-task')
await page.waitForTimeout(400)
out.emptyBandGoneWhileFiltering =
  (await page.locator('[data-testid="start-first-task"]').count()) === 0
await page.screenshot({ path: `${OUT}/s4-filtering.png` })

out.consoleErrors = errs
console.log(JSON.stringify(out, null, 2))
await browser.close()
