/**
 * WHERE THE TIME SITS ON A ONE-LINE SHELF (POD-1213).
 *
 * The reported fault: a pinned brief of a single line draws its timestamp
 * noticeably ABOVE the line of text it belongs to. Both live in the same flex
 * row, both top-aligned — but the text's line box is the brief's own 23px and
 * the time's is `line-height: 1` at micro size, so "top-aligned" puts their
 * glyphs five pixels apart.
 *
 * Measured, not eyeballed: a Range over the first text node gives the glyph box
 * of the first line; the same over the time's own text node gives its glyph box.
 * The offset between their centres IS the fault, and it is the number that has
 * to come back to zero. The shelf's total height is measured beside it, because
 * the cheap fixes for the offset all pay for it in slack under a one-line brief.
 *
 *   bunx vite --config apps/web/vite.harness.config.ts --port 55613
 *   bunx tsx apps/web/e2e/pod1213-shelf-align.ts
 */
import { chromium } from 'playwright'

const URL_ = 'http://localhost:55613/shelf-harness.html'
const W = 'transcript '

const CASES = [
  { name: 'one line', html: '<p>remove the "your work lands here" text</p>' },
  { name: 'two lines', html: `<p>${W.repeat(12)}</p>` },
  { name: 'clipped', html: `<p>${W.repeat(60)}</p>` },
]

type Shot = {
  offset: number
  shelfH: number
  textH: number
  sideH: number
  clipped: boolean
  fontOk: boolean
}

async function measure(page: import('playwright').Page): Promise<Shot> {
  return (await page.evaluate(`(() => {
    const shelf = document.querySelector('[data-testid="pinned-brief"] .brief-shelf')
    const text = shelf.querySelector('.brief-shelf-text')
    const time = shelf.querySelector('.brief-shelf-time')
    const side = shelf.querySelector('.brief-shelf-side')
    // The glyph box of the FIRST line, not the element box: a range rect is laid
    // out from the font's own ascent and descent, which is what the eye lines up.
    const firstLine = (el) => {
      // The first TEXT node, not the element: a range that spans block
      // boundaries hands back the block's own box, which is every line at once.
      const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
      const r = document.createRange()
      r.selectNodeContents(node)
      return r.getClientRects()[0]
    }
    const a = firstLine(text)
    const b = firstLine(time)
    const mid = (r) => r.top + r.height / 2
    return {
      offset: Math.round((mid(b) - mid(a)) * 100) / 100,
      shelfH: Math.round(shelf.getBoundingClientRect().height * 100) / 100,
      textH: Math.round(text.getBoundingClientRect().height * 100) / 100,
      sideH: Math.round(side.getBoundingClientRect().height * 100) / 100,
      clipped: shelf.getAttribute('data-clipped') === 'true',
      fontOk: document.fonts.check('14px "Geist Variable"'),
    }
  })()`)) as Shot
}

/**
 * THE FAULT, PUT BACK. Pass `--before` to restore the geometry that shipped —
 * the side column top-aligned at `line-height: 1`, and an idle toggle still
 * holding a row of height open. It is the positive control: a rig that reports
 * the same number before and after is measuring nothing.
 */
const BEFORE = `
  .brief-shelf-side { gap: 7px; padding-top: 1px; }
  .brief-shelf-time { line-height: 1; }
  .brief-shelf-toggle { margin-top: 0; }
  .brief-shelf-toggle[data-idle="true"] { height: auto; }
`

async function run(): Promise<void> {
  const before = process.argv.includes('--before')
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(URL_, { waitUntil: 'networkidle' })
  await page.waitForFunction('window.shelf !== undefined', undefined, { timeout: 20000 })
  await page.evaluate('window.shelf.setWidth(680)')
  if (before) await page.addStyleTag({ content: BEFORE })

  for (const density of ['default', 'compact'] as const) {
    await page.evaluate(`window.shelf.setDensity(${JSON.stringify(density)})`)
    for (const c of CASES) {
      await page.evaluate(`window.shelf.setBrief(${JSON.stringify(c.html)})`)
      await page.waitForTimeout(220)
      const m = await measure(page)
      console.log(
        `${before ? 'BEFORE ' : 'after  '}${density.padEnd(7)} ${c.name.padEnd(9)} ` +
          `time-vs-line ${String(m.offset).padStart(6)}px  ` +
          `shelf ${String(m.shelfH).padStart(6)}  text ${String(m.textH).padStart(6)}  ` +
          `side ${String(m.sideH).padStart(5)}  clipped=${m.clipped}  font=${m.fontOk}`,
      )
      if (density === 'default') {
        await page.locator('[data-testid="pinned-brief"]').screenshot({
          path: `apps/web/e2e/pod1213-${before ? 'before' : 'after'}-${c.name.replace(/ /g, '-')}.png`,
        })
      }
    }
  }
  if (errs.length > 0) console.log('PAGE ERRORS', errs)
  await browser.close()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
