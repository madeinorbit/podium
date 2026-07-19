/**
 * Read-only live large-state frontend measurement driver (POD-999).
 *
 * Records Tasks DOM scale, CLS, browser long tasks, issue-switch click
 * latency/traces, and the server perf snapshot. It never mutates live state.
 */
import { writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const base = process.env.BENCH_URL ?? 'http://localhost:8877'
const switches = Number(process.env.BENCH_SWITCHES ?? 12)
const rowsToRotate = Number(process.env.BENCH_ROWS ?? 6)
const dwellMs = Number(process.env.BENCH_DWELL ?? 1500)
const out = process.env.BENCH_OUT ?? 'large-state-live.json'
const storageState = process.env.BENCH_STORAGE_STATE

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  ignoreHTTPSErrors: true,
  ...(storageState ? { storageState } : {}),
})
const page = await context.newPage()

await page.addInitScript(() => {
  const sample = { cls: 0, longTasks: [] as Array<{ startTime: number; duration: number }> }
  ;(globalThis as typeof globalThis & { __largeStateSample?: typeof sample }).__largeStateSample =
    sample
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        sample.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
      }
    }).observe({ type: 'longtask', buffered: true })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
        if (!shift.hadRecentInput) sample.cls += shift.value ?? 0
      }
    }).observe({ type: 'layout-shift', buffered: true })
  } catch {
    // Older Chromium: DOM and switch traces remain useful.
  }
  localStorage.setItem('podium.panelMode', 'chat')
})

await page.goto(`${base}/?e2e=1&switchTrace=1`, { waitUntil: 'domcontentloaded' })
const closeOnboarding = page.getByRole('button', { name: 'Close' })
try {
  await closeOnboarding.click({ timeout: 10_000 })
} catch {
  // The live instance is already configured.
}
await page.getByRole('heading', { name: 'Tasks' }).waitFor({ timeout: 60_000 })
await page.waitForTimeout(4000)

const tasks = await page.evaluate(() => ({
  elements: document.querySelectorAll('*').length,
  buttons: document.querySelectorAll('button').length,
}))

const rows = page.locator('[data-testid="unified-issue-row"]')
const rowCount = Math.min(await rows.count(), rowsToRotate)
if (rowCount < 2) throw new Error(`only ${rowCount} issue rows are available for switching`)

const clickMs: number[] = []
for (let index = 0; index < switches; index++) {
  const row = rows.nth(index % rowCount)
  await row.scrollIntoViewIfNeeded()
  const started = performance.now()
  await row.click()
  clickMs.push(performance.now() - started)
  await page.waitForTimeout(dwellMs)
}
await page.waitForTimeout(1500)

const browserSample = await page.evaluate(() => {
  const scope = globalThis as typeof globalThis & {
    __largeStateSample?: {
      cls: number
      longTasks: Array<{ startTime: number; duration: number }>
    }
    __podiumSwitchTraces?: { recent(): unknown[] }
  }
  return {
    cls: scope.__largeStateSample?.cls ?? 0,
    longTasks: scope.__largeStateSample?.longTasks ?? [],
    traces: scope.__podiumSwitchTraces?.recent() ?? [],
  }
})
const snapshot = await page.evaluate(async () => {
  const response = await fetch('/trpc/perf.snapshot')
  return response.json()
})

const result = {
  base,
  capturedAt: new Date().toISOString(),
  tasks,
  navigation: { switches, rows: rowCount, clickMs },
  ...browserSample,
  snapshot,
}
await writeFile(out, JSON.stringify(result, null, 2))

const sorted = [...clickMs].sort((left, right) => left - right)
const percentile = (q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
const maxLongTask = Math.max(0, ...browserSample.longTasks.map((task) => task.duration))
console.log(
  JSON.stringify({
    out,
    tasks,
    cls: Math.round(browserSample.cls * 1000) / 1000,
    longTasks: browserSample.longTasks.length,
    maxLongTaskMs: Math.round(maxLongTask),
    switchTraces: browserSample.traces.length,
    clickP50Ms: Math.round(percentile(0.5)),
    clickP90Ms: Math.round(percentile(0.9)),
  }),
)

await browser.close()
