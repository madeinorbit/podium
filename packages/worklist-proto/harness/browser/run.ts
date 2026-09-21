/**
 * POD-4445 — Chromium timing driver: the ONE way every arm is timed.
 *
 * One invocation times ONE (arm, scale) pair — a killed browser run poisons
 * later renders in the same file (seen on F1), so interleaving across arms
 * happens by invoking this once per pair, never by looping pairs in-process.
 * Within a pair, scenarios rotate round-robin per sample.
 *
 * Per scenario sample: input-to-paint for the click (pointerdown dispatched
 * in-page, paint after two rAFs), scenario task duration, long tasks,
 * heap before/after with forced GC, per-record loadavg + uptime.
 *
 * Timing runs under the bench lease (`bench:ludovico`); counts do not need
 * it. Above load 8, do not publish walls — run counts only and say so.
 *
 * Field names overlap `docs/measurements/POD-4286-stage0-live.json` where
 * they measure the same thing: `runtimeSha`, `browser`, `capturedAt`,
 * heap `{before,after}` with CDP `usedSize`, `longTasks`/`longTaskMs`,
 * `commits`. See `docs/plans/pod-4441-harness.md` for the mapping.
 *
 * Run (heavy — browser + production build traffic):
 *   bun scripts/test-heavy.ts -- bun packages/worklist-proto/harness/browser/run.ts \
 *     --arm control --scale 1 --samples 5 --out harness/browser/results/control-1x.json
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join } from 'node:path'
import { loadavg, uptime } from 'node:os'
import { chromium } from '@playwright/test'

const ARMS = ['control', 'hand', 'mobx', 'tanstack'] as const
type ArmName = (typeof ARMS)[number]
type Scale = 1 | 2 | 4
const SCENARIOS = ['heartbeat', 'rename', 'stagemove', 'clock', 'click'] as const
type ScenarioName = (typeof SCENARIOS)[number]

interface Args {
  arm: ArmName
  scale: Scale
  scenarios: ScenarioName[]
  samples: number
  out: string
  port: number
  serve: string
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(flag)
    if (index < 0 || index + 1 >= argv.length) return fallback
    return argv[index + 1]
  }
  const arm = (get('--arm', 'control') ?? 'control') as string
  if (!(ARMS as readonly string[]).includes(arm)) {
    throw new Error(`--arm must be one of ${ARMS.join(', ')} (got ${arm})`)
  }
  const scale = Number(get('--scale', '1'))
  if (scale !== 1 && scale !== 2 && scale !== 4) throw new Error(`--scale must be 1, 2 or 4 (got ${scale})`)
  const scenarios = ((get('--scenarios', SCENARIOS.join(',')) ?? '').split(',') as string[]).map(
    (s) => s.trim(),
  )
  for (const scenario of scenarios) {
    if (!(SCENARIOS as readonly string[]).includes(scenario)) {
      throw new Error(`unknown scenario ${scenario} (want ${SCENARIOS.join(', ')})`)
    }
  }
  return {
    arm: arm as ArmName,
    scale: scale as Scale,
    scenarios: scenarios as ScenarioName[],
    samples: Number(get('--samples', '5')),
    out: get('--out', `harness/browser/results/${arm}-${scale}x.json`) ?? '',
    port: Number(get('--port', '8751')),
    serve: get('--serve', 'packages/worklist-proto/harness/web/dist') ?? '',
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
}

function serveDist(dir: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let file = join(dir, url.pathname === '/' ? 'control.html' : url.pathname.slice(1))
    // POD-4446: vite emits entries under `entries/` (multi-page input), so
    // `/hand.html` lives at `<serve>/entries/hand.html`. Fall back there.
    if (!existsSync(file) && file.endsWith('.html')) {
      file = join(dir, 'entries', url.pathname.split('/').pop() as string)
    }
    if (!existsSync(file) && file.endsWith('.html')) {
      res.writeHead(404)
      res.end('no such entry')
      return
    }
    try {
      const body = readFileSync(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

interface HeapUsage {
  usedSize: number
  totalSize: number
  embedderHeapUsedSize?: number
  backingStorageSize?: number
}

interface TimingRecord {
  arm: ArmName
  scale: Scale
  scenario: ScenarioName
  sample: number
  /** Click only: paint minus dispatched-pointerdown, ms. */
  inputToPaintMs: number | null
  /** Scenario wall including settle, ms. */
  taskMs: number
  /** Main-thread pipeline slices measured in-page (no paint, no poll). */
  actionMs: number
  longTasks: number
  longTaskMs: number
  heapBefore: HeapUsage | null
  heapAfter: HeapUsage | null
  commits: number
  mountedRows: number
  stats: { rowsDerived: number; rollupsDerived: number; indexUpdates: number; notifications: number }
  loadavg: number
  uptime: number
  runtimeSha: string
}

function acquireBenchLease(): boolean {
  const result = spawnSync('podium', ['lock', 'acquire', 'bench:ludovico', '--ttl', '30m'], {
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    console.error(`[browser] bench lease refused:\n${result.stdout}${result.stderr}`)
    return false
  }
  console.log('[browser] bench lease acquired')
  return true
}

function releaseBenchLease(): void {
  spawnSync('podium', ['lock', 'release', 'bench:ludovico'], { encoding: 'utf-8' })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runtimeSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf-8',
  }).trim()
  if (!acquireBenchLease()) {
    throw new Error(
      '[browser] refusing to time without the bench lease (walls would be contaminated). Counts only.',
    )
  }
  let server: Server | null = null
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    server = await serveDist(args.serve, args.port)
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const url = `http://127.0.0.1:${args.port}/${args.arm}.html?scale=${args.scale}&sha=${runtimeSha}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (window as unknown as { __proto?: { ready: boolean } }).__proto?.ready !== undefined, {}, { timeout: 120_000 })
    const proto = await page.evaluate(() => (window as unknown as { __proto: Record<string, unknown> }).__proto)
    if (proto['ready'] === false) {
      const skipped = {
        arm: args.arm,
        scale: args.scale,
        skipped: true,
        reason: 'page not ready (arm pending)',
        runtimeSha,
        capturedAt: new Date().toISOString(),
      }
      mkdirSync(join(args.out, '..'), { recursive: true })
      writeFileSync(args.out, JSON.stringify(skipped, null, 2))
      console.log(`[browser] ${args.arm}: page not ready, wrote skip record`)
      return
    }
    const corpus = await page.evaluate(
      () => (window as unknown as { __proto: { corpus: unknown } }).__proto.corpus,
    )
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    const heap = async (): Promise<HeapUsage> => {
      await cdp.send('HeapProfiler.collectGarbage')
      const usage = (await cdp.send('Runtime.getHeapUsage')) as HeapUsage
      return usage
    }
    const records: TimingRecord[] = []
    // Rotate scenarios round-robin per sample so drift hits every scenario.
    for (let sample = 0; sample < args.samples; sample += 1) {
      for (const scenario of args.scenarios) {
        const heapBefore = await heap()
        let record: TimingRecord
        if (scenario === 'click') {
          const painted = (await page.evaluate(() =>
            (
              window as unknown as {
                __proto: {
                  clickRow: () => Promise<{
                    inputMs: number
                    paintMs: number
                    actionMs: number
                    longTasks: { duration: number }[]
                    commits: number
                    mountedRows: number
                  }>
                }
              }
            ).__proto.clickRow(),
          )) as {
            inputMs: number
            paintMs: number
            actionMs: number
            longTasks: { duration: number }[]
            commits: number
            mountedRows: number
          }
          record = {
            arm: args.arm,
            scale: args.scale,
            scenario,
            sample,
            inputToPaintMs: painted.paintMs - painted.inputMs,
            taskMs: painted.paintMs - painted.inputMs,
            actionMs: painted.actionMs,
            longTasks: painted.longTasks.length,
            longTaskMs: painted.longTasks.reduce((sum, t) => sum + t.duration, 0),
            heapBefore,
            heapAfter: null,
            commits: painted.commits,
            mountedRows: painted.mountedRows,
            stats: { rowsDerived: 0, rollupsDerived: 0, indexUpdates: 0, notifications: 0 },
            loadavg: loadavg()[0] ?? 0,
            uptime: uptime(),
            runtimeSha,
          }
        } else {
          const result = (await page.evaluate((name: string) =>
            (
              window as unknown as {
                __proto: {
                  runScenario: (n: string) => Promise<{
                    commits: number
                    mountedRows: number
                    stats: {
                      rowsDerived: number
                      rollupsDerived: number
                      indexUpdates: number
                      notifications: number
                    }
                    taskMs: number
                    actionMs: number
                    longTasks: { duration: number }[]
                  }>
                }
              }
            ).__proto.runScenario(name),
          scenario)) as unknown as {
            commits: number
            mountedRows: number
            stats: {
              rowsDerived: number
              rollupsDerived: number
              indexUpdates: number
              notifications: number
            }
            taskMs: number
            actionMs: number
            longTasks: { duration: number }[]
          }
          record = {
            arm: args.arm,
            scale: args.scale,
            scenario,
            sample,
            inputToPaintMs: null,
            taskMs: result.taskMs,
            actionMs: result.actionMs,
            longTasks: result.longTasks.length,
            longTaskMs: result.longTasks.reduce((sum, t) => sum + t.duration, 0),
            heapBefore,
            heapAfter: null,
            commits: result.commits,
            mountedRows: result.mountedRows,
            stats: result.stats,
            loadavg: loadavg()[0] ?? 0,
            uptime: uptime(),
            runtimeSha,
          }
        }
        record.heapAfter = await heap()
        records.push(record)
        console.log(
          `[browser] ${args.arm} ${args.scale}x ${scenario}#${sample}: ` +
            `taskMs=${Math.round(record.taskMs)} longTasks=${record.longTasks} commits=${record.commits}`,
        )
      }
    }
    const output = {
      runtimeSha,
      browser: browser.version(),
      capturedAt: new Date().toISOString(),
      arm: args.arm,
      scale: args.scale,
      corpus,
      scenarios: args.scenarios,
      samples: args.samples,
      records,
    }
    mkdirSync(join(args.out, '..'), { recursive: true })
    writeFileSync(args.out, JSON.stringify(output, null, 2))
    console.log(`[browser] wrote ${args.out} (${records.length} records)`)
  } finally {
    await browser.close()
    server !== null && server.close()
    releaseBenchLease()
  }
}

await main()
