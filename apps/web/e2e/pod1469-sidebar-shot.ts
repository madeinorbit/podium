/**
 * POD-1469: the work sidebar's new head, its filter line and an empty project's
 * band, shot from the stubbed harness (`vite.sidebar.config.ts`, port 55597).
 *
 * Three widths, because the whole `Add repository` decision is about what
 * happens when the operator drags the column in: 306 is the default, 240 is a
 * squeeze, 200 is the minimum the shell allows and the one where the button
 * gives up its words.
 *
 *   bun apps/web/e2e/pod1469-sidebar-shot.ts <outDir>
 */
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/pod1469'
const ORIGIN = 'http://localhost:55597/sidebar-harness.html'

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 700, height: 900 },
  deviceScaleFactor: 2,
})
const page = await ctx.newPage()
page.setDefaultTimeout(60_000)

for (const mode of ['dark', 'light'] as const) {
  for (const width of [306, 240, 200]) {
    await page.goto(`${ORIGIN}?rows=7&width=${String(width)}&mode=${mode}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForSelector('[data-testid="new-task-button"]')
    await page.waitForTimeout(900)
    const shot = `${OUT}/sidebar-${mode}-${String(width)}.png`
    await page.locator('[data-testid="sidebar-harness"]').screenshot({ path: shot })
    console.log(shot)

    {
      // The numbers that survive into a commit message: does the button keep its
      // words, and is it on the filter's line rather than under it?
      const facts = await page.evaluate(() => {
        const add = document.querySelector('[data-testid="add-repository"]') as HTMLElement
        const search = document.querySelector('[data-testid="work-search"]') as HTMLElement
        const head = document.querySelector('[data-testid="new-task-button"]') as HTMLElement
        const label = add.querySelector('.worklist-add-repo-label') as HTMLElement
        return {
          // `textContent` is no use here — it reports a `display:none` span just
          // as happily as a painted one, which is how the first run of this
          // probe reported the words present at every width. Ask the box.
          addLabelPainted: label.getBoundingClientRect().width > 0,
          addWidth: Math.round(add.getBoundingClientRect().width),
          fieldWidth: Math.round(search.getBoundingClientRect().width),
          sameLine:
            Math.abs(add.getBoundingClientRect().top - search.getBoundingClientRect().top) < 2,
          headHeight: Math.round(head.getBoundingClientRect().height),
          bands: document.querySelectorAll('[data-testid="project-group-label"]').length,
          startFirstTask: document.querySelectorAll('[data-testid="start-first-task"]').length,
          footer: document.querySelectorAll('[data-testid="palette-hint"]').length,
        }
      })
      console.log(`${String(width)}px ${JSON.stringify(facts)}`)
    }
  }
}
await browser.close()
