/**
 * Read-only live large-state frontend measurement driver (POD-999).
 *
 * Records Tasks DOM scale, CLS, browser long tasks, issue-switch click
 * latency/traces, and the server perf snapshot. It never mutates live state.
 */
import { hostname } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const base = process.env.BENCH_URL ?? 'http://localhost:8877'
const switches = Number(process.env.BENCH_SWITCHES ?? 12)
const rowsToRotate = Number(process.env.BENCH_ROWS ?? 2)
const idleMs = Number(process.env.BENCH_IDLE_MS ?? 65_800)
const runner = process.env.BENCH_RUNNER ?? hostname()
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

const rows = page.locator('[data-issue-row]')
const rowCount = Math.min(await rows.count(), rowsToRotate)
if (rowCount < 2) throw new Error(`only ${rowCount} issue rows are available for switching`)

const rowIds = (
  await rows.evaluateAll((elements) => elements.map((el) => el.getAttribute('data-issue-row')))
).slice(0, rowCount)
// Start an idle capture after startup settles. A2 publishes and their work
// remain separate fields, including when host telemetry publishes elsewhere.
await page.evaluate(() => {
  const scope = globalThis as typeof globalThis & {
    __podiumStoreStats?: { enable(): void; reset(): void }
    __largeStateSample?: { longTasks: unknown[] }
  }
  if (!scope.__podiumStoreStats) throw new Error('A2 store counters unavailable')
  scope.__podiumStoreStats.enable()
  scope.__podiumStoreStats.reset()
  if (scope.__largeStateSample) scope.__largeStateSample.longTasks.length = 0
})
await page.waitForTimeout(idleMs)
const idle = await page.evaluate(() => {
  const scope = globalThis as typeof globalThis & {
    __podiumStoreStats: { snapshot(): unknown; reset(): void }
    __largeStateSample?: { longTasks: Array<{ startTime: number; duration: number }> }
    __podiumSwitchTraces?: { recent(): Array<{ switchId: string }> }
  }
  const counts = scope.__podiumStoreStats.snapshot()
  scope.__podiumStoreStats.reset()
  const longTasks = [...(scope.__largeStateSample?.longTasks ?? [])]
  if (scope.__largeStateSample) scope.__largeStateSample.longTasks.length = 0
  return {
    counts,
    longTasks,
    priorSwitchIds: scope.__podiumSwitchTraces?.recent().map((t) => t.switchId) ?? [],
  }
})
const clickMs: number[] = []
for (let index = 0; index < switches; index++) {
  const id = rowIds[index % rowCount]
  const row = page.locator(`[data-issue-row=${JSON.stringify(id)}]`)
  await row.scrollIntoViewIfNeeded()
  const started = performance.now()
  await row.locator('button[data-pressable]').first().click()
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
    __podiumSwitchTraces?: {
      recent(): Array<{
        switchId: string
        cold: boolean
        timedOut: boolean
        totalMs: number
        marks: Array<{ name: string; atMs: number }>
      }>
    }
  }
  return {
    cls: scope.__largeStateSample?.cls ?? 0,
    longTasks: scope.__largeStateSample?.longTasks ?? [],
    traces: scope.__podiumSwitchTraces?.recent() ?? [],
    storeStats: (
      globalThis as typeof globalThis & { __podiumStoreStats?: { snapshot(): unknown } }
    ).__podiumStoreStats?.snapshot(),
  }
})
const snapshot = await page.evaluate(async () => {
  const response = await fetch('/trpc/perf.snapshot')
  return response.json()
})

const classified = browserSample.traces
  .filter((trace) => !idle.priorSwitchIds.includes(trace.switchId))
  .map((trace) => ({
    ...trace,
    classification: trace.timedOut ? 'timedOut' : trace.cold ? 'cold' : 'warm',
  }))
const traceDistributions = Object.fromEntries(
  ['cold', 'warm', 'timedOut'].map((classification) => {
    const values = classified
      .filter((trace) => trace.classification === classification)
      .map((trace) => trace.totalMs)
      .sort((a, b) => a - b)
    return [
      classification,
      {
        n: values.length,
        p50: values[Math.ceil(values.length * 0.5) - 1] ?? null,
        p95: values[Math.ceil(values.length * 0.95) - 1] ?? null,
      },
    ]
  }),
)
const result = {
  base,
  runner,
  browserVersion: browser.version(),
  idle: { durationMs: idleMs, counts: idle.counts, longTasks: idle.longTasks },
  capturedAt: new Date().toISOString(),
  tasks,
  navigation: { switches, rows: rowCount, rowIds, clickMs },
  ...browserSample,
  snapshot,
  classified,
  traceDistributions,
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
    traceDistributions,
    missingTraces: Math.max(0, switches - classified.length),
    idleLongTasks: idle.longTasks.length,
    clickP50Ms: Math.round(percentile(0.5)),
    clickP90Ms: Math.round(percentile(0.9)),
  }),
)

await browser.close()
