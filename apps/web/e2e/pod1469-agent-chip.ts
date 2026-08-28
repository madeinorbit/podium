/**
 * POD-1469: the agent chip, close up, for every harness it can wear.
 *
 * The chip used to carry a 7px Claude-clay square whichever harness was
 * selected. It draws the selected harness's own glyph now, so the thing to look
 * at is whether that glyph READS at 13px in `--muted-foreground` — a mark that
 * dissolves into a smudge is not an improvement on a dot.
 *
 *   bun apps/web/e2e/pod1469-agent-chip.ts <outDir>
 */
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/pod1469'
const ORIGIN = 'http://localhost:55598/coldstart-harness.html?first=0'

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1180, height: 720 },
  deviceScaleFactor: 4,
})
const page = await ctx.newPage()
page.setDefaultTimeout(60_000)

for (const mode of ['dark', 'light'] as const) {
  for (const harness of ['claude-code', 'codex', 'grok', 'opencode', 'cursor']) {
    await page.goto(`${ORIGIN}&agent=${harness}`, { waitUntil: 'domcontentloaded' })
    await page.evaluate((m) => {
      document.documentElement.dataset.theme = 'podium'
      document.documentElement.classList.toggle('dark', m === 'dark')
    }, mode)
    const chip = page.getByRole('button', { name: 'Agent' })
    await chip.waitFor()
    await page.waitForTimeout(500)
    const shot = `${OUT}/chip-${mode}-${harness}.png`
    await chip.screenshot({ path: shot })
    const facts = await chip.evaluate((el) => ({
      label: (el.textContent ?? '').trim(),
      glyphs: el.querySelectorAll('svg').length,
      swatch: el.querySelectorAll('.bg-claude').length,
    }))
    console.log(`${mode} ${harness} ${JSON.stringify(facts)}`)
  }
}
await browser.close()
