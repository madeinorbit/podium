/**
 * Production Expo mobile-web performance benchmark.
 *
 * Run the regular browser harness first, then invoke this driver against it:
 *
 *   PORT=18967 bun --conditions=@podium/source tests/e2e/serve-harness.ts
 *   BENCH_URL=http://localhost:18967 bun tests/e2e/mobile-performance-bench.ts
 *
 * The harness owns isolated state. This driver seeds a deterministic large task
 * set, opens the production Expo export at a Pixel viewport, and exercises the
 * same Work, Tasks, search, and mission routes in a fresh Chromium process for
 * every sample. It measures the supported mobile-web runtime, not native frame
 * timing; BENCH_ANDROID_DIR can add static Android export size evidence.
 */
import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, devices, type Page } from '@playwright/test'

const base = process.env.BENCH_URL ?? 'http://localhost:8799'
const samples = Number(process.env.BENCH_SAMPLES ?? 6)
const warmups = Number(process.env.BENCH_WARMUPS ?? 1)
const issueCount = Number(process.env.BENCH_ISSUES ?? 674)
const out = process.env.BENCH_OUT ?? 'mobile-performance.json'
const cpuRate = Number(process.env.BENCH_CPU_RATE ?? 4)
const networkLatencyMs = Number(process.env.BENCH_NETWORK_LATENCY_MS ?? 40)
const downloadMbps = Number(process.env.BENCH_DOWNLOAD_MBPS ?? 10)
const uploadMbps = Number(process.env.BENCH_UPLOAD_MBPS ?? 2)
const skipSeed = process.env.BENCH_SKIP_SEED === '1'
const profileCpu = process.env.BENCH_CPU_PROFILE === '1'
const androidDir = process.env.BENCH_ANDROID_DIR
const targetTitle = `Mobile benchmark target ${String(issueCount - 1).padStart(4, '0')}`

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
  tasksRouteMs: number
  workReturnMs: number
  searchSettledMs: number
  missionOpenMs: number
  maxInteractionMs: number
  longTaskCount: number
  maxLongTaskMs: number
  totalLongTaskMs: number
  phaseLongTasks: Record<string, { count: number; totalMs: number; maxMs: number }>
  httpRequests: number
  httpTransferBytes: number
  websocketReceiveBytes: number
  resourceTransferBytes: number
  resourceDecodedBytes: number
  routeResourceTransferBytes: number
  domElements: number
  jsHeapUsedBytes: number
  nodes: number
  layoutCount: number
  scriptDurationMs: number
  taskDurationMs: number
  largestResources: ResourceMetric[]
  cpuTop: Array<{
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
    selfMs: number
    samples: number
  }>
  errors: string[]
}

interface AssetTotals {
  rawBytes: number
  brotliBytes: number
  gzipBytes: number
  jsRawBytes: number
  hbcRawBytes: number
  entryRawBytes: number
  entryBrotliBytes: number
  entryGzipBytes: number
  wasmRawBytes: number
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

async function seedIssues(): Promise<void> {
  const repos = await rpc<string[]>('repos.list', undefined, 'GET')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('the benchmark harness registered no repository')

  const batchSize = 16
  for (let offset = 0; offset < issueCount; offset += batchSize) {
    await Promise.all(
      Array.from({ length: Math.min(batchSize, issueCount - offset) }, async (_, batchIndex) => {
        const index = offset + batchIndex
        const created = await rpc<{ id: string }>('issues.create', {
          repoPath,
          title:
            index === issueCount - 1
              ? targetTitle
              : `Generated mobile task ${String(index).padStart(4, '0')}`,
          description: `Deterministic mobile benchmark task ${index % 17}`,
          startNow: false,
        })
        await rpc('issues.update', { id: created.id, patch: { stage: 'in_progress' } })
      }),
    )
  }
}

async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
}

function phaseSummary(
  rows: BrowserVitals['longTasks'],
  startTime: number,
  endTime: number,
): { count: number; totalMs: number; maxMs: number } {
  const durations = rows
    .filter((task) => task.startTime >= startTime && task.startTime < endTime)
    .map((task) => task.duration)
  return {
    count: durations.length,
    totalMs: durations.reduce((sum, duration) => sum + duration, 0),
    maxMs: Math.max(0, ...durations),
  }
}

function summarizeCpuProfile(profile: unknown): Sample['cpuTop'] {
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
  const sampleIds = parsed.profile?.samples ?? []
  const deltas = parsed.profile?.timeDeltas ?? []
  for (let index = 0; index < sampleIds.length; index += 1) {
    const id = sampleIds[index]
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
    .slice(0, 50)
}

async function runSample(index: number, measured: boolean): Promise<Sample> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const pixel = devices['Pixel 7']
  const context = await browser.newContext({
    viewport: pixel.viewport,
    userAgent: pixel.userAgent,
    deviceScaleFactor: pixel.deviceScaleFactor,
    isMobile: pixel.isMobile,
    hasTouch: pixel.hasTouch,
  })
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
      globalThis as typeof globalThis & { __mobilePerformanceSample?: BrowserVitals }
    ).__mobilePerformanceSample = sample
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
      // Primary wall-clock timings and CDP counters remain available.
    }
  })

  const startedAt = performance.now()
  try {
    if (profileCpu) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 1_000 })
      await cdp.send('Profiler.start')
    }
    const relay = base.replace(/^http/, 'ws')
    await page.goto(`${base}/mobile/work?server=${encodeURIComponent(relay)}&e2e=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    })
    await page.getByRole('button', { name: 'New work' }).waitFor({
      state: 'visible',
      timeout: 90_000,
    })
    await twoFrames(page)
    const shellReadyMs = performance.now() - startedAt
    await page.waitForTimeout(250)

    const tasksStart = await page.evaluate(() => performance.now())
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('button', { name: 'New task' }).waitFor({
      state: 'visible',
      timeout: 30_000,
    })
    await page.waitForURL(/\/mobile\/issues(?:\?|$)/, { timeout: 30_000 })
    await twoFrames(page)
    const tasksEnd = await page.evaluate(() => performance.now())

    const workStart = tasksEnd
    await page.getByRole('tab', { name: 'Work', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Search work' }).waitFor({
      state: 'visible',
      timeout: 30_000,
    })
    await page.waitForURL(/\/mobile\/work(?:\?|$)/, { timeout: 30_000 })
    await twoFrames(page)
    const workEnd = await page.evaluate(() => performance.now())

    const searchStart = workEnd
    await page.getByRole('button', { name: 'Search work' }).click({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Search work' }).fill(targetTitle)
    const target = page.getByText(targetTitle, { exact: true }).first()
    await target.waitFor({ state: 'visible', timeout: 30_000 })
    await twoFrames(page)
    const searchEnd = await page.evaluate(() => performance.now())

    const missionStart = searchEnd
    await target.click({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Mission actions' }).waitFor({
      state: 'visible',
      timeout: 30_000,
    })
    await page.waitForURL(/\/mobile\/mission\//, { timeout: 30_000 })
    await twoFrames(page)
    const missionEnd = await page.evaluate(() => performance.now())
    await page.waitForTimeout(250)
    const cpuProfile = profileCpu ? await cdp.send('Profiler.stop') : undefined

    const metrics = await cdp.send('Performance.getMetrics')
    const metric = new Map((metrics.metrics ?? []).map((row) => [row.name, row.value]))
    const browserVitals = await page.evaluate(() => {
      const sample = (
        globalThis as typeof globalThis & { __mobilePerformanceSample?: BrowserVitals }
      ).__mobilePerformanceSample
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
    const longDurations = browserVitals.longTasks.map((task) => task.duration)
    const interactionDurations = browserVitals.events
      .filter((event) => event.interactionId !== 0)
      .map((event) => event.duration)
    const routeResourceTransferBytes = browserVitals.resources
      .filter((resource) => resource.startTime >= tasksStart)
      .reduce((sum, resource) => sum + resource.transferSize, 0)

    const sample: Sample = {
      shellReadyMs,
      fcpMs: browserVitals.fcpMs,
      lcpMs: browserVitals.lcpMs,
      lcpElement: browserVitals.lcpElement,
      cls: browserVitals.cls,
      tasksRouteMs: tasksEnd - tasksStart,
      workReturnMs: workEnd - workStart,
      searchSettledMs: searchEnd - searchStart,
      missionOpenMs: missionEnd - missionStart,
      maxInteractionMs: Math.max(0, ...interactionDurations),
      longTaskCount: longDurations.length,
      maxLongTaskMs: Math.max(0, ...longDurations),
      totalLongTaskMs: longDurations.reduce((sum, duration) => sum + duration, 0),
      phaseLongTasks: {
        shell: phaseSummary(browserVitals.longTasks, 0, tasksStart),
        tasks: phaseSummary(browserVitals.longTasks, tasksStart, tasksEnd),
        workReturn: phaseSummary(browserVitals.longTasks, workStart, workEnd),
        search: phaseSummary(browserVitals.longTasks, searchStart, searchEnd),
        mission: phaseSummary(browserVitals.longTasks, missionStart, missionEnd),
      },
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
      routeResourceTransferBytes,
      domElements: await page.evaluate(() => document.querySelectorAll('*').length),
      jsHeapUsedBytes: metric.get('JSHeapUsedSize') ?? 0,
      nodes: metric.get('Nodes') ?? 0,
      layoutCount: metric.get('LayoutCount') ?? 0,
      scriptDurationMs: (metric.get('ScriptDuration') ?? 0) * 1_000,
      taskDurationMs: (metric.get('TaskDuration') ?? 0) * 1_000,
      largestResources: [...browserVitals.resources]
        .sort((left, right) => right.decodedBodySize - left.decodedBodySize)
        .slice(0, 15),
      cpuTop: summarizeCpuProfile(cpuProfile),
      errors,
    }
    const label = measured ? 'sample' : 'warmup'
    console.log(
      `[mobile-perf] ${label} ${index + 1}/${measured ? samples : warmups}: ` +
        `shell=${Math.round(sample.shellReadyMs)}ms tasks=${Math.round(sample.tasksRouteMs)}ms ` +
        `search=${Math.round(sample.searchSettledMs)}ms mission=${Math.round(sample.missionOpenMs)}ms`,
    )
    return sample
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

async function assetTotals(root: string): Promise<AssetTotals> {
  const totals: AssetTotals = {
    rawBytes: 0,
    brotliBytes: 0,
    gzipBytes: 0,
    jsRawBytes: 0,
    hbcRawBytes: 0,
    entryRawBytes: 0,
    entryBrotliBytes: 0,
    entryGzipBytes: 0,
    wasmRawBytes: 0,
  }
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      const bytes = (await stat(path)).size
      const isEntry = /(?:^|\/)entry-[^/]+\.(?:js|hbc)(?:\.(?:br|gz))?$/.test(path)
      if (entry.name.endsWith('.br')) {
        totals.brotliBytes += bytes
        if (isEntry) totals.entryBrotliBytes += bytes
      } else if (entry.name.endsWith('.gz')) {
        totals.gzipBytes += bytes
        if (isEntry) totals.entryGzipBytes += bytes
      } else if (!entry.name.endsWith('.map')) {
        totals.rawBytes += bytes
        if (entry.name.endsWith('.js')) totals.jsRawBytes += bytes
        if (entry.name.endsWith('.hbc')) totals.hbcRawBytes += bytes
        if (entry.name.endsWith('.wasm')) totals.wasmRawBytes += bytes
        if (isEntry) totals.entryRawBytes += bytes
      }
    }
  }
  await walk(root)
  return totals
}

console.log(
  skipSeed
    ? `[mobile-perf] using existing ${issueCount}-task state at ${base}`
    : `[mobile-perf] seeding ${issueCount} tasks at ${base}`,
)
if (!skipSeed) await seedIssues()

const webAssets = await assetTotals(resolve(import.meta.dir, '../../apps/mobile/dist'))
const androidAssets = androidDir ? await assetTotals(resolve(androidDir)) : undefined
for (let index = 0; index < warmups; index += 1) await runSample(index, false)

const measured: Sample[] = []
for (let index = 0; index < samples; index += 1) {
  measured.push(await runSample(index, true))
  await Bun.write(
    out,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        incomplete: true,
        environment: {
          runtime: 'production Expo web export',
          browser: 'chromium',
          device: 'Pixel 7 descriptor',
          viewport: devices['Pixel 7'].viewport,
          cpuThrottleRate: cpuRate,
          network: { latencyMs: networkLatencyMs, downloadMbps, uploadMbps },
          cacheDisabled: true,
          freshBrowserPerSample: true,
          warmups,
        },
        scale: { issues: issueCount },
        assets: { web: webAssets, ...(androidAssets ? { android: androidAssets } : {}) },
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
    'tasksRouteMs',
    'workReturnMs',
    'searchSettledMs',
    'missionOpenMs',
    'maxInteractionMs',
    'longTaskCount',
    'maxLongTaskMs',
    'totalLongTaskMs',
    'httpTransferBytes',
    'websocketReceiveBytes',
    'resourceTransferBytes',
    'resourceDecodedBytes',
    'routeResourceTransferBytes',
    'domElements',
    'jsHeapUsedBytes',
    'nodes',
    'layoutCount',
    'scriptDurationMs',
    'taskDurationMs',
  ].map((key) => [key, summarize(measured.map((sample) => sample[key as keyof Sample] as number))]),
)

const result = {
  capturedAt: new Date().toISOString(),
  environment: {
    runtime: 'production Expo web export',
    browser: 'chromium',
    device: 'Pixel 7 descriptor',
    viewport: devices['Pixel 7'].viewport,
    cpuThrottleRate: cpuRate,
    network: { latencyMs: networkLatencyMs, downloadMbps, uploadMbps },
    cacheDisabled: true,
    freshBrowserPerSample: true,
    warmups,
    nativeRuntimeMeasured: false,
  },
  scale: { issues: issueCount },
  assets: { web: webAssets, ...(androidAssets ? { android: androidAssets } : {}) },
  summary,
  samples: measured,
}
await Bun.write(out, JSON.stringify(result, null, 2))
console.log(`[mobile-perf] wrote ${out}`)
console.log(JSON.stringify(summary))

const sampleErrors = measured.flatMap((sample, index) =>
  sample.errors.map((error) => `sample ${index + 1}: ${error}`),
)
if (sampleErrors.length > 0) {
  throw new Error(`benchmark observed browser errors:\n${sampleErrors.join('\n')}`)
}
