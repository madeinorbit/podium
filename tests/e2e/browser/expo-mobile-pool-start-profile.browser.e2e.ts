/** Where does the pool-only phone's warm start spend its time?
 *
 * Production phone export, Pixel Chromium, operator-sized synthetic corpus
 * (6,100 issues, 5,200 sessions). Warm = the IndexedDB replica retained from
 * the previous launch. Each sample is a fresh document launch of the session
 * screen through the permanent pool reader. The last OFF control is recorded
 * in POD-5407's landed evidence at01e22dd14d, before its removal here.
 * Timing samples run without tracing; traced samples carry V8 CPU samples for
 * offline attribution by tests/e2e/phone-profile-analyze.ts.
 *
 * Opt-in only: PODIUM_PHONE_PROFILE=1, run while holding bench:flatblock. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type CDPSession, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'
import {
  firstLaunch,
  observeErrors,
  SIZED_CORPUS,
  saveTrace,
  seedSession,
  sizedBootstrap,
  traceStart,
} from './_phone-profile'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium phone export profile',
)
test.use({ serviceWorkers: 'block' })
const artifacts = resolve(import.meta.dirname, '../../../.artifacts/POD-5391')
const title = 'Phone warm start profile'
const samples = Number(process.env.PODIUM_PHONE_PROFILE_SAMPLES ?? 3)
const POST_SETTLE_MS = 5_000

interface Sample {
  pool: true
  traced: boolean
  /** Document navigation start → session screen DOM complete + two frames. */
  settledMs: number
  domMs: number
  /** End of the last >50 ms main-thread task within POST_SETTLE_MS after
   * settling (or settledMs): work the screen did not wait for, such as a pool
   * attachment, still blocks the next tap until then. */
  busyUntilMs: number
  longTasks: { start: number; duration: number }[]
  poolChunk: boolean
  /** Full bootstraps fetched by THIS launch; a warm launch fetches none. */
  bootstraps: number
  heapBytes: number
  trace?: string
}

async function openSession(
  page: Page,
  sessionId: string,
  cdp: CDPSession,
  bootstraps: () => number,
  trace?: string,
): Promise<Sample> {
  const before = bootstraps()
  let poolChunk = false
  const onRequest = (request: { url(): string }) => {
    if (/\/runtime-pool[^/]*\.js$/.test(new URL(request.url()).pathname)) poolChunk = true
  }
  page.on('request', onRequest)
  const stop = trace ? await traceStart(cdp) : undefined
  try {
    await page.goto(`/mobile/session/${sessionId}?server=${RELAY}&e2e=1`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => Reflect.get(window, '__phoneSettled') !== undefined, null, {
      timeout: 120_000,
    })
    await page.waitForTimeout(POST_SETTLE_MS)
  } finally {
    const events = await stop?.()
    if (events && trace) saveTrace(resolve(artifacts, trace), events)
    page.off('request', onRequest)
  }
  // The same visible boundary POD-5171 waited on.
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible()
  await expect(page.getByLabel('Session actions')).toBeVisible()
  await expect(page.getByRole('textbox').last()).toBeVisible()
  const observed = await page.evaluate(() => ({
    settledMs: Reflect.get(window, '__phoneSettled') as number,
    domMs: Reflect.get(window, '__phoneDom') as number,
    longTasks: (Reflect.get(window, '__phoneLongTasks') ?? []) as {
      start: number
      duration: number
    }[],
  }))
  await cdp.send('HeapProfiler.collectGarbage')
  const heapBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize
  const busyUntilMs = observed.longTasks
    .map((task) => task.start + task.duration)
    .filter((end) => end <= observed.settledMs + POST_SETTLE_MS)
    .reduce((latest, end) => Math.max(latest, end), observed.settledMs)
  return {
    pool: true,
    traced: trace !== undefined,
    ...observed,
    busyUntilMs,
    poolChunk,
    bootstraps: bootstraps() - before,
    heapBytes,
    trace,
  }
}

test('pool-only phone warm start into a session, timed and profiled', async ({ page }) => {
  test.skip(
    process.env.PODIUM_PHONE_PROFILE !== '1',
    'Run only while holding bench:flatblock, with PODIUM_PHONE_PROFILE=1',
  )
  test.setTimeout(1_800_000)
  mkdirSync(artifacts, { recursive: true })
  if (process.env.PODIUM_PHONE_PROFILE_DEBUG === '1')
    await page.addInitScript(() => Reflect.set(globalThis, '__phoneIdbDebug', true))
  await page.addInitScript((expected) => {
    const w = window as unknown as Record<string, unknown>
    const tasks: { start: number; duration: number }[] = []
    w.__phoneLongTasks = tasks
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        tasks.push({ start: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
    const open = indexedDB.open.bind(indexedDB)
    indexedDB.open = (name: string, version?: number) => {
      const at = performance.now(),
        request = open(name, version)
      const log = (what: string) =>
        console.info(
          `[idb] ${name} v${version} ${what} after ${(performance.now() - at).toFixed(0)} ms (opened at ${at.toFixed(0)})`,
        )
      request.addEventListener('success', () => log('success'))
      request.addEventListener('error', () => log(`error ${request.error?.name}`))
      request.addEventListener('blocked', () => log('blocked'))
      request.addEventListener('upgradeneeded', () => log('upgradeneeded'))
      return request
    }
    if (Reflect.get(globalThis, '__phoneIdbDebug')) {
      const counts: Record<string, number> = {}
      const bump = (key: string) => {
        counts[key] = (counts[key] ?? 0) + 1
      }
      for (const method of [
        'put',
        'add',
        'delete',
        'clear',
        'getAll',
        'openCursor',
        'get',
      ] as const) {
        const original = IDBObjectStore.prototype[method] as (...args: unknown[]) => IDBRequest
        ;(IDBObjectStore.prototype as unknown as Record<string, unknown>)[method] = function (
          this: IDBObjectStore,
          ...args: unknown[]
        ) {
          bump(`${method}:${this.name}`)
          if (method === 'clear')
            console.info(`[idb] clear ${this.name} at ${performance.now().toFixed(0)}`)
          return original.apply(this, args)
        }
      }
      const transaction = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (
        this: IDBDatabase,
        ...args: Parameters<IDBDatabase['transaction']>
      ) {
        const tx = transaction.apply(this, args)
        const at = performance.now()
        tx.addEventListener('abort', () =>
          console.info(
            `[idb] abort ${String(args[0])} ${tx.error?.name} ${tx.error?.message} after ${(performance.now() - at).toFixed(0)} ms`,
          ),
        )
        tx.addEventListener('complete', () => {
          const ms = performance.now() - at
          if (ms > 200)
            console.info(
              `[idb] slow complete ${String(args[0])} ${args[1] ?? 'readonly'} ${ms.toFixed(0)} ms`,
            )
        })
        return tx
      } as IDBDatabase['transaction']
      addEventListener('pagehide', () =>
        console.info(`[idb] counts ${location.pathname} ${JSON.stringify(counts)}`),
      )
    }
    if (!location.pathname.includes('/session/')) return
    const ready = () =>
      document.querySelector('[aria-label="Session actions"]') !== null &&
      document.querySelector('textarea, input[type="text"], [role="textbox"]') !== null &&
      (document.body?.textContent ?? '').includes(expected)
    const observer = new MutationObserver(() => {
      if (!ready()) return
      observer.disconnect()
      w.__phoneDom = performance.now()
      performance.mark('phone:dom')
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          performance.mark('phone:settled')
          w.__phoneSettled = performance.now()
        }),
      )
    })
    observer.observe(document, { subtree: true, childList: true, attributes: true })
  }, title)
  const observed = observeErrors(page),
    seed = await seedSession(page, title),
    corpus = await sizedBootstrap(page, seed)
  const cdp = await page.context().newCDPSession(page)
  if (process.env.PODIUM_PHONE_PROFILE_DEBUG === '1')
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame())
        console.log(`[nav ${new Date().toISOString()}] ${frame.url()}`)
    })
  if (process.env.PODIUM_PHONE_PROFILE_DEBUG === '1')
    page.on('response', async (response) => {
      const url = new URL(response.url())
      if (!url.pathname.startsWith('/sync/')) return
      const body =
        response.status() === 409 ? (await response.text().catch(() => '')).slice(0, 300) : ''
      console.log(
        `[sync ${new Date().toISOString()}] ${response.status()} ${url.pathname}${url.search} ${body}`,
      )
    })
  await firstLaunch(page)
  // Warm the pool reader once; retained IndexedDB is what "warm" means.
  const run = (trace?: string) =>
    openSession(page, seed.sessionId, cdp, corpus.installations, trace)
  await run()
  const timed: Sample[] = [],
    traced: Sample[] = []
  const order = Array.from({ length: samples }, () => true)
  for (const _pool of order) timed.push(await run())
  for (const [index] of order.entries()) traced.push(await run(`warm-on-${index}.trace.json.gz`))
  expect(corpus.installations()).toBeGreaterThan(0)
  // Every measured launch is warm: it resumed from the saved cursor.
  expect([...timed, ...traced].map((sample) => sample.bootstraps)).toEqual(
    [...timed, ...traced].map(() => 0),
  )
  expect(observed.errors, observed.errors.join('\n')).toEqual([])
  const median = (list: Sample[], pick: (s: Sample) => number = (s) => s.settledMs) => {
    const values = list.map(pick)
    return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  }
  const busy = (s: Sample) => s.busyUntilMs
  const report = {
    corpus: SIZED_CORPUS,
    browser: page.context().browser()?.version(),
    method:
      'Fresh pool-only document launch of /mobile/session/:id with the IndexedDB replica retained and its cursor saved by the previous launch (warm: zero bootstrap fetches, asserted). settledMs = navigation start → Session actions, a textbox and the session title in the DOM + two animation frames (in-page MutationObserver). busyUntilMs = end of the last >50 ms long task up to 5 s after settling. Timed samples carry no tracing; traced samples carry a Chromium trace with V8 CPU samples.',
    order,
    medians: {
      timedOn: median(timed),
      tracedOn: median(traced),
      busyTimedOn: median(timed, busy),
    },
    timed,
    traced,
    bootstrapInstallations: corpus.installations(),
    errors: observed.errors.length,
    resource401: observed.resource401(),
  }
  writeFileSync(resolve(artifacts, 'warm-start.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.info('[phone warm start]', JSON.stringify(report.medians))
})
