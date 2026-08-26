/**
 * POD-1253: shoot and measure the shipping sidebar in the harness
 * (`vite.sidebar.config.ts`), where the main thread is still between presses.
 *
 *   bun apps/web/e2e/pod1253-harness.ts <outDir> [origin]
 *
 * Prints the artboard's numbers, then samples a collapse and an expand frame by
 * frame — with an IDLE run first, because a slow fold and a busy app measure the
 * same without one.
 */
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/pod1253'
const ORIGIN = process.argv[3] ?? 'http://127.0.0.1:55597'
const PAGE = `${ORIGIN}/sidebar-harness.html`

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 420, height: 900 },
  deviceScaleFactor: 2,
})
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console] ${m.text().slice(0, 300)}`)
})
page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`))
page.setDefaultTimeout(60_000)

/** Prove the shipping face actually loaded — `document.fonts.check` does not. */
async function fontsLoaded(): Promise<unknown> {
  return page.evaluate(() =>
    [...(document as unknown as { fonts: Iterable<FontFace> }).fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => f.family)
      .filter((v, i, a) => a.indexOf(v) === i),
  )
}

const shoot = async (mode: string, label: string): Promise<void> => {
  await page.goto(`${PAGE}?mode=${mode}&rows=24`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="work-scroll"]')
  await page.waitForTimeout(2500)
  await page.locator('[data-testid="sidebar-harness"]').screenshot({ path: `${OUT}/${label}.png` })
  console.log(label, 'fonts:', JSON.stringify(await fontsLoaded()))
}

await shoot('light', 'harness-light')
await shoot('dark', 'harness-dark')

const geometry = await page.evaluate(() => {
  const box = (sel: string) => {
    const el = document.querySelector(sel)
    if (!el) return `MISSING ${sel}`
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return `h=${Math.round(r.height * 10) / 10} pad=${cs.padding} gap=${cs.gap} r=${cs.borderRadius}`
  }
  const rows = [...document.querySelectorAll('.shell-work-row')]
  const heights = new Map<string, number>()
  for (const r of rows) {
    const key = r.querySelector('[data-testid="row-progress"]') ? 'metered' : 'bare'
    heights.set(key, Math.round(r.getBoundingClientRect().height))
  }
  return {
    spawnBlock: box('[data-testid="new-agent-button"]'),
    spawnBtn: box('[data-testid="new-agent-button"] button'),
    band: box('[data-testid="project-group-label"]'),
    closedFold: box('[data-testid="closed-fold-toggle"]'),
    rowHeights: Object.fromEntries(heights),
    rowCount: rows.length,
  }
})
console.log('geometry:', JSON.stringify(geometry, null, 1))

const sample = async (what: 'idle' | 'collapse' | 'expand'): Promise<void> => {
  const out = await page.evaluate(async (click: boolean) => {
    const band = document.querySelector('[data-testid="project-group-label"]') as HTMLElement | null
    const scroller = document.querySelector('[data-testid="work-scroll"]') as HTMLElement | null
    if (!band || !scroller) return { error: 'missing' }
    const longTasks: number[] = []
    const obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTasks.push(Math.round(e.duration))
    })
    try {
      obs.observe({ entryTypes: ['longtask'] })
    } catch {
      /* unsupported */
    }
    const stamps: number[] = []
    const heights: number[] = []
    let stop = false
    const tick = (t: number): void => {
      stamps.push(t)
      heights.push(Math.round(scroller.scrollHeight))
      if (!stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    if (click) band.click()
    await new Promise((r) => setTimeout(r, 900))
    stop = true
    obs.disconnect()
    const span = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0
    let worst = 0
    for (let i = 1; i < stamps.length; i++) worst = Math.max(worst, stamps[i] - stamps[i - 1])
    const travel = Math.abs(heights[0] - heights[heights.length - 1])
    let biggest = 0
    for (let i = 1; i < heights.length; i++)
      biggest = Math.max(biggest, Math.abs(heights[i] - heights[i - 1]))
    const moved = heights.filter((h, i) => i > 0 && h !== heights[i - 1]).length
    return {
      frames: stamps.length,
      fps: span ? Math.round((stamps.length / span) * 1000) : 0,
      worstFrameGapMs: Math.round(worst),
      longTaskTotalMs: longTasks.reduce((a, b) => a + b, 0),
      longTasks: longTasks.slice(0, 8),
      movingFrames: moved,
      travel,
      biggestStepPct: travel ? Math.round((biggest / travel) * 100) : 0,
    }
  }, what !== 'idle')
  console.log(`${what.padEnd(8)}:`, JSON.stringify(out))
}

await sample('idle')
await page.waitForTimeout(400)
await sample('collapse')
await page.waitForTimeout(600)
await sample('expand')

await browser.close()
