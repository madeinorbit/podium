/**
 * POD-1306 — MEASURE the mission spine, do not eyeball it.
 *
 * The filed screenshot shows two things a picture cannot settle: a rail that
 * appears to hang off the gauge chip rather than run in a gutter, and a
 * selection tick that reads as the line disappearing behind the agent tile.
 * Both are x-coordinates, so this prints them.
 *
 *   bun apps/web/e2e/pod1306-spine.ts
 */
import { chromium } from 'playwright'

const ORIGIN = process.env.P1306_ORIGIN ?? 'http://127.0.0.1:55601'
const OUT = process.env.P1306_OUT ?? 'apps/web/e2e'
const TAG = process.env.P1306_TAG ?? 'before'

/** Every absolutely-positioned hairline in the column, plus the left edge of
 *  each thing that is supposed to stand clear of it. */
const MEASURE = (): unknown => {
  const col = document.querySelector('[data-resizable-column]') as HTMLElement | null
  if (!col) return { error: 'no column' }
  const origin = col.getBoundingClientRect().left
  const rel = (r: DOMRect): Record<string, number> => ({
    left: Math.round((r.left - origin) * 100) / 100,
    right: Math.round((r.right - origin) * 100) / 100,
    top: Math.round(r.top * 100) / 100,
    w: Math.round(r.width * 100) / 100,
    h: Math.round(r.height * 100) / 100,
  })
  const marks: unknown[] = []
  for (const el of Array.from(col.querySelectorAll('span[aria-hidden]'))) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    // A rail or a tick: narrow and tall, or short and wide (an elbow).
    if (r.width > 6 && r.height > 6) continue
    marks.push({ ...rel(r), cls: String((el as HTMLElement).className).slice(0, 44) })
  }
  const named: Record<string, unknown> = {}
  const put = (key: string, el: Element | null): void => {
    if (el) named[key] = rel(el.getBoundingClientRect())
  }
  const h2 = col.querySelector('h2')
  put('h2Title', h2)
  put('desc', h2?.closest('div')?.querySelector('p') ?? null)
  put('viewBarFirstTab', col.querySelector('button[aria-pressed]'))
  const agentRow = col.querySelector('[data-flight-session]')
  put('agentRow', agentRow)
  put('agentTile', agentRow?.querySelector('svg')?.parentElement ?? null)
  put('firstStrip', col.querySelector('[data-flight-issue]'))
  return { colWidth: col.getBoundingClientRect().width, named, marks }
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 2,
  })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  console.error:', m.text().slice(0, 200))
  })
  await page.goto(`${ORIGIN}/harness/deck.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-flight-session]', { timeout: 30_000 })
  await page.waitForTimeout(900)

  for (const mission of ['draft', 'asking', 'roster'] as const) {
    await page.evaluate(
      (m) => (window as never as { deck: { setMission: (n: string) => void } }).deck.setMission(m),
      mission,
    )
    await page.waitForTimeout(700)
    console.log(`\n== ${mission}`)
    console.log(JSON.stringify(await page.evaluate(MEASURE), null, 1))
    const col = await page.$('[data-resizable-column]')
    const box = await col?.boundingBox()
    if (box) {
      await page.screenshot({
        path: `${OUT}/pod1306-${TAG}-${mission}.png`,
        clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 560) },
      })
    }
  }
  await browser.close()
}

void main()
