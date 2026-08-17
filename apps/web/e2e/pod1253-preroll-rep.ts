/**
 * POD-1253: the pre-roll at one size, repeated, because this host runs a fleet
 * and a single sample here is noise. Prints every trial plus the median.
 *
 *   bun apps/web/e2e/pod1253-preroll-rep.ts [origin] [rows] [trials]
 */
import { chromium } from 'playwright'

const ORIGIN = process.argv[2] ?? 'http://localhost:55596'
const ROWS = process.argv[3] ?? '24'
const TRIALS = Number(process.argv[4] ?? 5)

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage()
// The PWA plugin still emits a service worker into the build; an unregistered
// one is the difference between measuring this bundle and measuring whatever
// was cached first (see the preview-service-worker trap).
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'serviceWorker', { get: () => undefined })
})
await page.goto(`${ORIGIN}/sidebar-harness.html?rows=${ROWS}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('[data-testid="work-scroll"]')
await page.waitForTimeout(3000)

const once = async (): Promise<{ prerollMs: number; animMs: number; frames: number }> =>
  page.evaluate(async () => {
    const band = document.querySelector('[data-testid="project-group-label"]') as HTMLElement
    const seen: Array<[number, string]> = []
    let stop = false
    const t0 = performance.now()
    const tick = (): void => {
      const el = document.querySelector('[data-testid="project-group-rows"]') as HTMLElement | null
      seen.push([performance.now() - t0, el ? el.style.height || 'auto' : 'gone'])
      if (!stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    const clicked = performance.now() - t0
    band.click()
    await new Promise((r) => setTimeout(r, 1200))
    stop = true
    const moving = seen.filter(([, h]) => h !== 'auto' && h !== 'gone')
    const first = moving[0]?.[0] ?? Number.NaN
    const last = moving[moving.length - 1]?.[0] ?? Number.NaN
    return {
      prerollMs: Math.round(first - clicked),
      animMs: Math.round(last - first),
      frames: moving.length,
    }
  })

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const collapse: number[] = []
const expand: number[] = []
for (let i = 0; i < TRIALS; i++) {
  const c = await once()
  await page.waitForTimeout(500)
  const e = await once()
  await page.waitForTimeout(500)
  collapse.push(c.prerollMs)
  expand.push(e.prerollMs)
  console.log(`trial ${i + 1}: collapse ${JSON.stringify(c)}  expand ${JSON.stringify(e)}`)
}
console.log(
  `rows=${ROWS} median preroll — collapse ${median(collapse)}ms, expand ${median(expand)}ms`,
)
await browser.close()
