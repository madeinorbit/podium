/**
 * Production web performance benchmark.
 *
 * Run the regular browser harness first, then invoke this driver against it:
 *
 *   PORT=18966 bun --conditions=@podium/source tests/e2e/serve-harness.ts
 *   BENCH_URL=http://localhost:18966 bun tests/e2e/web-performance-bench.ts
 *
 * The harness owns isolated state. This driver seeds a deterministic large task
 * set before opening the browser, then measures read-only navigation and search
 * interactions in a fresh Chromium process for every sample.
 */
import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, type CDPSession, type Page } from '@playwright/test'

const base = process.env.BENCH_URL ?? 'http://localhost:8799'
const samples = Number(process.env.BENCH_SAMPLES ?? 5)
const issueCount = Number(process.env.BENCH_ISSUES ?? 674)
const out = process.env.BENCH_OUT ?? 'web-performance.json'
const cpuRate = Number(process.env.BENCH_CPU_RATE ?? 4)
const networkLatencyMs = Number(process.env.BENCH_NETWORK_LATENCY_MS ?? 40)
const downloadMbps = Number(process.env.BENCH_DOWNLOAD_MBPS ?? 10)
const uploadMbps = Number(process.env.BENCH_UPLOAD_MBPS ?? 2)
const skipSeed = process.env.BENCH_SKIP_SEED === '1'
const profileRoute = process.env.BENCH_CPU_PROFILE === '1'
const targetTitle = `Benchmark target ${String(issueCount - 1).padStart(4, '0')}`

type MetricMap = Record<string, number>

interface BrowserVitals {
  cls: number
  fcpMs: number
  lcpMs: number
  lcpElement: { tagName: string; text: string; size: number } | null
  longTasks: Array<{ startTime: number; duration: number }>
  events: Array<{ name: string; startTime: number; duration: number; interactionId: number }>
}

interface ResourceMetric {
  name: string
  initiatorType: string
  startTime: number
  transferSize: number
  encodedBodySize: number
  decodedBodySize: number
}

interface Sample {
  shellReadyMs: number
  fcpMs: number
  lcpMs: number
  lcpElement: BrowserVitals['lcpElement']
  cls: number
  routeReadyMs: number
  searchSettledMs: number
  issueOpenMs: number
  maxInteractionMs: number
  longTaskCount: number
  maxLongTaskMs: number
  totalLongTaskMs: number
  httpRequests: number
  httpTransferBytes: number
  websocketReceiveBytes: number
  resourceTransferBytes: number
  resourceDecodedBytes: number
  domElements: number
  taskCards: number
  routeResourceTransferBytes: number
  phaseLongTasks: Record<string, { count: number; totalMs: number; maxMs: number }>
  largestResources: ResourceMetric[]
  routeCpuTop: Array<{
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
    selfMs: number
    samples: number
  }>
  browser: MetricMap
  interactionDelta: MetricMap
  errors: string[]
}

async function rpc<T>(procedure: string, input?: unknown, method: 'GET' | 'POST' = 'POST') {
  const response = await fetch(`${base}/trpc/${procedure}`, {
    method,
    ...(method === 'POST'
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}) }
      : {}),
  })
  if (!response.ok) throw new Error(`${procedure} -> ${response.status}: ${await response.text()}`)
  const body = (await response.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

async function seedIssues(): Promise<string> {
  const repos = await rpc<string[]>('repos.list', undefined, 'GET')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('the benchmark harness registered no repository')

  const batchSize = 16
  for (let offset = 0; offset < issueCount; offset += batchSize) {
    await Promise.all(
      Array.from({ length: Math.min(batchSize, issueCount - offset) }, (_, batchIndex) => {
        const index = offset + batchIndex
        return rpc('issues.create', {
          repoPath,
          title:
            index === issueCount - 1
              ? targetTitle
              : `Generated benchmark task ${String(index).padStart(4, '0')}`,
          description: `Deterministic benchmark task ${index % 17}`,
          startNow: false,
        })
      }),
    )
  }
  return repoPath
}

async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  )
}

function metricsMap(result: { metrics?: Array<{ name: string; value: number }> }): MetricMap {
  const rows = result.metrics ?? []
  return Object.fromEntries(rows.map(({ name, value }) => [name, value]))
}

const trackedMetrics = [
  'Documents',
  'Frames',
  'JSEventListeners',
  'Nodes',
  'LayoutCount',
  'RecalcStyleCount',
  'LayoutDuration',
  'RecalcStyleDuration',
  'ScriptDuration',
  'TaskDuration',
  'JSHeapUsedSize',
  'JSHeapTotalSize',
] as const

function pickMetrics(metrics: MetricMap): MetricMap {
  return Object.fromEntries(trackedMetrics.map((name) => [name, metrics[name] ?? 0]))
}

function subtractMetrics(after: MetricMap, before: MetricMap): MetricMap {
  return Object.fromEntries(
    trackedMetrics.map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)]),
  )
}

function summarizeCpuProfile(profile: unknown): Sample['routeCpuTop'] {
  if (profile === undefined || profile === null) return []
  const parsed = profile as {
    profile?: {
      nodes?: Array<{
        id: number
        callFrame: {
          functionName: string
          url: string
          lineNumber: number
          columnNumber: number
        }
      }>
      samples?: number[]
      timeDeltas?: number[]
    }
  }
  const nodes = new Map((parsed.profile?.nodes ?? []).map((node) => [node.id, node.callFrame]))
  const totals = new Map<number, { selfMs: number; samples: number }>()
  const samples = parsed.profile?.samples ?? []
  const deltas = parsed.profile?.timeDeltas ?? []
  for (let index = 0; index < samples.length; index += 1) {
    const id = samples[index]
    if (id === undefined) continue
    const current = totals.get(id) ?? { selfMs: 0, samples: 0 }
    current.selfMs += (deltas[index] ?? 0) / 1_000
    current.samples += 1
    totals.set(id, current)
  }
  return [...totals]
    .map(([id, total]) => ({
      ...(nodes.get(id) ?? { functionName: '(unknown)', url: '', lineNumber: 0, columnNumber: 0 }),
      selfMs: Math.round(total.selfMs * 10) / 10,
      samples: total.samples,
    }))
    .sort((left, right) => right.selfMs - left.selfMs)
    .slice(0, 40)
}

async function runSample(index: number): Promise<Sample> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const errors: string[] = []
  let httpRequests = 0
  let httpTransferBytes = 0
  let websocketReceiveBytes = 0

  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  cdp.on('Network.requestWillBeSent', () => {
    httpRequests += 1
  })
  cdp.on('Network.loadingFinished', (event) => {
    httpTransferBytes += event.encodedDataLength
  })
  cdp.on('Network.webSocketFrameReceived', (event) => {
    websocketReceiveBytes += Buffer.byteLength(event.response.payloadData)
  })

  await Promise.all([
    cdp.send('Performance.enable'),
    cdp.send('Network.enable'),
    cdp.send('Network.setCacheDisabled', { cacheDisabled: true }),
    cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate }),
  ])
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: networkLatencyMs,
    downloadThroughput: (downloadMbps * 1024 * 1024) / 8,
    uploadThroughput: (uploadMbps * 1024 * 1024) / 8,
  })

  await page.addInitScript(() => {
    const sample: BrowserVitals = {
      cls: 0,
      fcpMs: 0,
      lcpMs: 0,
      lcpElement: null,
      longTasks: [],
      events: [],
    }
    ;(
      globalThis as typeof globalThis & { __webPerformanceSample?: BrowserVitals }
    ).__webPerformanceSample = sample
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const paint = entry as LargestContentfulPaint
          sample.lcpMs = paint.startTime
          sample.lcpElement = {
            tagName: paint.element?.tagName.toLowerCase() ?? '',
            text: paint.element?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120) ?? '',
            size: paint.size,
          }
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true })
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
          if (!shift.hadRecentInput) sample.cls += shift.value ?? 0
        }
      }).observe({ type: 'layout-shift', buffered: true })
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          sample.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
        }
      }).observe({ type: 'longtask', buffered: true })
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const event = entry as PerformanceEventTiming
          sample.events.push({
            name: event.name,
            startTime: event.startTime,
            duration: event.duration,
            interactionId: event.interactionId,
          })
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 })
      new PerformanceObserver((list) => {
        for (const entry of list.getEntriesByName('first-contentful-paint')) {
          sample.fcpMs = entry.startTime
        }
      }).observe({ type: 'paint', buffered: true })
    } catch {
      // The primary timings and CDP counters remain available on older Chromium.
    }
  })

  const startedAt = performance.now()
  try {
    await page.goto(`${base}/?server=${base.replace(/^http/, 'ws')}&e2e=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    })
    await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
      timeout: 90_000,
    })
    await page.locator('aside').first().waitFor({ state: 'visible', timeout: 90_000 })
    await twoFrames(page)
    const shellReadyMs = performance.now() - startedAt
    await page.waitForTimeout(500)

    const beforeInteractions = metricsMap(await cdp.send('Performance.getMetrics'))
    if (profileRoute) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 1_000 })
      await cdp.send('Profiler.start')
    }
    const routeStarted = await page.evaluate(() => performance.now())
    await page.getByTestId('topbar-nav-issues').click({ timeout: 30_000 })
    const tasks = page.getByRole('region', { name: 'Tasks' })
    await tasks.waitFor({ state: 'visible', timeout: 30_000 })
    await twoFrames(page)
    const routeReadyMs = (await page.evaluate(() => performance.now())) - routeStarted
    const routeProfile = profileRoute ? await cdp.send('Profiler.stop') : undefined

    const search = page.getByRole('textbox', { name: 'Search tasks' })
    const searchStarted = await page.evaluate(() => performance.now())
    await search.fill(targetTitle)
    await page.waitForFunction(
      (title) => {
        const task = [...document.querySelectorAll<HTMLElement>('[data-issue-id]')].find((node) =>
          node.textContent?.includes(String(title)),
        )
        return task !== undefined
      },
      targetTitle,
      { timeout: 30_000 },
    )
    await twoFrames(page)
    const searchSettledMs = (await page.evaluate(() => performance.now())) - searchStarted
    const taskCards = await tasks.locator('[data-issue-id]').count()

    const target = tasks.locator('[data-issue-id]').filter({ hasText: targetTitle }).first()
    const openStarted = await page.evaluate(() => performance.now())
    await target.click({ timeout: 30_000 })
    await page.locator('button[title="Back"]').waitFor({ state: 'visible', timeout: 30_000 })
    await twoFrames(page)
    const issueOpenMs = (await page.evaluate(() => performance.now())) - openStarted
    const interactionsEnded = await page.evaluate(() => performance.now())
    await page.waitForTimeout(250)

    const afterInteractions = metricsMap(await cdp.send('Performance.getMetrics'))
    const browserVitals = await page.evaluate(() => {
      const sample = (globalThis as typeof globalThis & { __webPerformanceSample?: BrowserVitals })
        .__webPerformanceSample
      const resources = performance
        .getEntriesByType('resource')
        .map((entry) => entry as PerformanceResourceTiming)
        .map((entry) => ({
          name: entry.name,
          initiatorType: entry.initiatorType,
          startTime: entry.startTime,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        }))
      return {
        cls: sample?.cls ?? 0,
        fcpMs: sample?.fcpMs ?? 0,
        lcpMs: sample?.lcpMs ?? 0,
        lcpElement: sample?.lcpElement ?? null,
        longTasks: sample?.longTasks ?? [],
        events: sample?.events ?? [],
        resources,
      }
    })
    const domElements = await page.evaluate(() => document.querySelectorAll('*').length)
    const interactionDurations = browserVitals.events
      .filter((event) => event.interactionId !== 0)
      .map((event) => event.duration)
    const longTaskDurations = browserVitals.longTasks.map((task) => task.duration)
    const summarizeLongTasks = (start: number, end: number) => {
      const durations = browserVitals.longTasks
        .filter((task) => task.startTime >= start && task.startTime < end)
        .map((task) => task.duration)
      return {
        count: durations.length,
        totalMs: durations.reduce((sum, duration) => sum + duration, 0),
        maxMs: Math.max(0, ...durations),
      }
    }
    const phaseLongTasks = {
      shell: summarizeLongTasks(0, routeStarted),
      route: summarizeLongTasks(routeStarted, searchStarted),
      search: summarizeLongTasks(searchStarted, openStarted),
      open: summarizeLongTasks(openStarted, interactionsEnded),
    }
    const largestResources = [...browserVitals.resources]
      .sort((left, right) => right.decodedBodySize - left.decodedBodySize)
      .slice(0, 15)

    console.log(
      `[web-perf] sample ${index + 1}/${samples}: shell=${Math.round(shellReadyMs)}ms ` +
        `tasks=${Math.round(routeReadyMs)}ms search=${Math.round(searchSettledMs)}ms ` +
        `open=${Math.round(issueOpenMs)}ms long=${longTaskDurations.length}`,
    )
    return {
      shellReadyMs,
      fcpMs: browserVitals.fcpMs,
      lcpMs: browserVitals.lcpMs,
      lcpElement: browserVitals.lcpElement,
      cls: browserVitals.cls,
      routeReadyMs,
      searchSettledMs,
      issueOpenMs,
      maxInteractionMs: Math.max(0, ...interactionDurations),
      longTaskCount: longTaskDurations.length,
      maxLongTaskMs: Math.max(0, ...longTaskDurations),
      totalLongTaskMs: longTaskDurations.reduce((sum, duration) => sum + duration, 0),
      httpRequests,
      httpTransferBytes,
      websocketReceiveBytes,
      resourceTransferBytes: browserVitals.resources.reduce(
        (sum, resource) => sum + resource.transferSize,
        0,
      ),
      resourceDecodedBytes: browserVitals.resources.reduce(
        (sum, resource) => sum + resource.decodedBodySize,
        0,
      ),
      domElements,
      taskCards,
      routeResourceTransferBytes: browserVitals.resources
        .filter((resource) => resource.startTime >= routeStarted)
        .reduce((sum, resource) => sum + resource.transferSize, 0),
      phaseLongTasks,
      largestResources,
      routeCpuTop: summarizeCpuProfile(routeProfile),
      browser: pickMetrics(afterInteractions),
      interactionDelta: subtractMetrics(afterInteractions, beforeInteractions),
      errors,
    }
  } finally {
    await browser.close()
  }
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] ?? 0
}

function summarize(values: number[]) {
  return {
    p50: Math.round(percentile(values, 0.5) * 100) / 100,
    p90: Math.round(percentile(values, 0.9) * 100) / 100,
  }
}

async function shippedAssets() {
  const root = resolve(import.meta.dir, '../../apps/web/dist')
  const totals = { rawBytes: 0, brotliBytes: 0, gzipBytes: 0, jsRawBytes: 0, cssRawBytes: 0 }
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      const bytes = (await stat(path)).size
      if (entry.name.endsWith('.br')) totals.brotliBytes += bytes
      else if (entry.name.endsWith('.gz')) totals.gzipBytes += bytes
      else if (!entry.name.endsWith('.map')) {
        totals.rawBytes += bytes
        if (entry.name.endsWith('.js')) totals.jsRawBytes += bytes
        if (entry.name.endsWith('.css')) totals.cssRawBytes += bytes
      }
    }
  }
  await walk(root)
  return totals
}

console.log(
  skipSeed
    ? `[web-perf] using the existing ${issueCount}-task state at ${base}`
    : `[web-perf] seeding ${issueCount} tasks at ${base}`,
)
if (!skipSeed) await seedIssues()
const assets = await shippedAssets()
const measured: Sample[] = []
for (let index = 0; index < samples; index += 1) {
  measured.push(await runSample(index))
  // Keep every completed browser run if a later fresh process stalls or the
  // shared host is interrupted. The final write below replaces this checkpoint
  // with the summarized report once all requested samples finish.
  await Bun.write(
    out,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        incomplete: true,
        environment: {
          browser: 'chromium',
          viewport: { width: 1440, height: 900 },
          cpuThrottleRate: cpuRate,
          network: { latencyMs: networkLatencyMs, downloadMbps, uploadMbps },
          cacheDisabled: true,
          freshBrowserPerSample: true,
        },
        scale: { issues: issueCount },
        assets,
        samples: measured,
      },
      null,
      2,
    ),
  )
}

const summary = Object.fromEntries(
  [
    'shellReadyMs',
    'fcpMs',
    'lcpMs',
    'cls',
    'routeReadyMs',
    'searchSettledMs',
    'issueOpenMs',
    'maxInteractionMs',
    'longTaskCount',
    'maxLongTaskMs',
    'totalLongTaskMs',
    'httpTransferBytes',
    'websocketReceiveBytes',
    'resourceTransferBytes',
    'resourceDecodedBytes',
    'domElements',
    'taskCards',
  ].map((key) => [key, summarize(measured.map((sample) => sample[key as keyof Sample] as number))]),
)

const result = {
  capturedAt: new Date().toISOString(),
  environment: {
    browser: 'chromium',
    viewport: { width: 1440, height: 900 },
    cpuThrottleRate: cpuRate,
    network: { latencyMs: networkLatencyMs, downloadMbps, uploadMbps },
    cacheDisabled: true,
    freshBrowserPerSample: true,
  },
  scale: { issues: issueCount },
  assets,
  summary,
  samples: measured,
}
await Bun.write(out, JSON.stringify(result, null, 2))
console.log(`[web-perf] wrote ${out}`)
console.log(JSON.stringify(summary))

const sampleErrors = measured.flatMap((sample, index) =>
  sample.errors.map((error) => `sample ${index + 1}: ${error}`),
)
if (sampleErrors.length > 0) {
  throw new Error(`benchmark observed browser errors:\n${sampleErrors.join('\n')}`)
}
