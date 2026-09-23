/**
 * POD-4445 — Chromium timing driver: the ONE way every arm is timed.
 * POD-4558 (L5b) — work time only.
 *
 * One invocation times ONE (arm, scale) pair — a killed browser run poisons
 * later renders in the same file (seen on F1), so interleaving across arms
 * happens by invoking this once per pair (`matrix.ts` does that, in rotated
 * order), never by looping pairs in-process. Within a pair, the scenario
 * order rotates per sample.
 *
 * Per scenario sample the page's timer (`harness/web/entrylib.ts`) reports
 * `actionMs` (change dispatch to the arm's last commit signal: the work),
 * `drainMs`, `frameMs` (to the next animation frame; reported, not budgeted),
 * commits, mounts, long tasks in the change's window, and stray commits that
 * landed between changes. The click goes through the same timer: its
 * dispatch is the pointer event. There is no task-time metric: no poll, no
 * frame wait inside any budgeted number. Around the page call the driver adds
 * heap before/after (CDP, forced GC), loadavg and uptime per record, and the
 * runtime SHA.
 *
 * PARITY (POD-4559). After every sample, outside the timed window, the driver
 * compares the page's `snapshotHash()` (the arm's slice output) with its
 * `oracleHash()` (the oracle over the same engine state); a mismatch fails
 * the run and names the first differing row. The no-op floor draws a frozen
 * boot snapshot by design and is exempt unless `--strict-parity` (the proof
 * that the comparison fails a wrong arm).
 *
 * A run FAILS (status `failed`, exit 2) when the 1-minute load is above
 * `--max-load` (default 8) before or during it, when any cell errors (a
 * missing cell is never a gap), on a parity mismatch, or on stray commits.
 * Its records stay in the JSON for diagnosis; `summarize.ts` refuses to
 * print them as results.
 *
 * Timing runs under the bench lease of the machine it runs on (`bench:<hostname>`);
 * round three times on flatblock through `matrix.ts --host flatblock`, which
 * takes `bench:flatblock` itself and passes `--no-lease`.
 *
 * Field names overlap `docs/measurements/POD-4286-stage0-live.json` where
 * they measure the same thing: `runtimeSha`, `browser`, `capturedAt`,
 * heap `{before,after}` with CDP `usedSize`, `longTasks`/`longTaskMs`,
 * `commits`. See `docs/plans/pod-4441-harness.md` for the mapping.
 *
 * Run (heavy — browser + production build traffic):
 *   bun scripts/test-heavy.ts -- bun packages/worklist-proto/harness/browser/run.ts \
 *     --arm noop --scale 1 --samples 5 --out packages/worklist-proto/harness/browser/results/noop-1x.json
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { hostname, loadavg, uptime } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { chromium } from '@playwright/test'
import type { ProtoOracleCheck, ProtoScenarioResult } from '../web/entrylib'
import {
  ARMS,
  type ArmName,
  type HeapUsage,
  type RunOutput,
  SCENARIOS,
  type Scale,
  type ScenarioName,
  type TimingRecord,
} from './records'

/** One viewport for every arm and scale, tall enough that the first window
 *  (`FIRST_WINDOW_ROWS`, `entrylib.ts`) holds a drawn target for every
 *  scenario at 4x, below a pinned section that grows with the corpus. */
const VIEWPORT = { width: 1600, height: 2400 }

/** The arms held to the oracle in check mode; the control (whole-list redraw)
 *  and the no-op page (draws nothing) exist to fail it and are reported only. */
const CANDIDATE_ARMS = new Set<ArmName>(['hand', 'mobx'])

/** The floor draws its boot snapshot forever: parity is reported, not enforced, unless `--strict-parity`. */
const PARITY_EXEMPT = new Set<ArmName>(['noop'])

interface Args {
  arm: ArmName
  scale: Scale
  scenarios: ScenarioName[]
  samples: number
  warmup: number
  maxLoad: number
  out: string
  port: number
  serve: string
  lease: boolean
  plant: string | null
  check: boolean
  offwindow: boolean
  strictParity: boolean
  markSettle: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(flag)
    if (index < 0 || index + 1 >= argv.length) return fallback
    return argv[index + 1]
  }
  const arm = (get('--arm', 'control') ?? 'control') as string
  if (get('--plant') !== undefined && arm !== 'noop')
    throw new Error('--plant is for --arm noop only')
  if (!(ARMS as readonly string[]).includes(arm)) {
    throw new Error(`--arm must be one of ${ARMS.join(', ')} (got ${arm})`)
  }
  const scale = Number(get('--scale', '1'))
  if (scale !== 1 && scale !== 2 && scale !== 4)
    throw new Error(`--scale must be 1, 2 or 4 (got ${scale})`)
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
    // Per page load: each click takes a fresh mounted row (a window holds ~17).
    samples: Number(get('--samples', '5')),
    warmup: Number(get('--warmup', '1')),
    maxLoad: Number(get('--max-load', '8')),
    out:
      get('--out', `packages/worklist-proto/harness/browser/results/${arm}-${scale}x.json`) ?? '',
    port: Number(get('--port', '8751')),
    serve: get('--serve', 'packages/worklist-proto/harness/web/dist') ?? '',
    // `matrix.ts` holds the lease around each invocation itself.
    lease: !argv.includes('--no-lease'),
    // A timer self-test plant on the noop page (`noop-arm.tsx`); never a floor run.
    plant: get('--plant') ?? null,
    // Proof mode: every record compares the arm's redraw with the oracle's
    // changed rows; a mismatch on a candidate arm fails the run.
    check: argv.includes('--check'),
    // Proof plant: the rename aims at the library's visibleRootId, off the
    // windowed arms' first window; the run must fail there. Never a timing run.
    offwindow: argv.includes('--offwindow'),
    // Proof plant: hold the no-op floor to parity too; the run must fail.
    strictParity: argv.includes('--strict-parity'),
    // Proof plant: drop the step's mark-read settle; the control's strays return.
    markSettle: !argv.includes('--no-mark-settle'),
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

function acquireBenchLease(): boolean {
  const result = spawnSync(
    'podium',
    ['lock', 'acquire', `bench:${hostname()}`, '--ttl', '30m', '--wait'],
    {
      encoding: 'utf-8',
    },
  )
  if (result.status !== 0) {
    console.error(`[browser] bench lease refused:\n${result.stdout}${result.stderr}`)
    return false
  }
  console.log('[browser] bench lease acquired')
  return true
}

function releaseBenchLease(): void {
  spawnSync('podium', ['lock', 'release', `bench:${hostname()}`], { encoding: 'utf-8' })
}

function write(out: string, output: RunOutput): void {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(output, null, 2))
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const runtimeSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf-8',
  }).trim()
  const output: RunOutput = {
    status: 'ok',
    failures: [],
    runtimeSha,
    host: hostname(),
    browser: null,
    capturedAt: new Date().toISOString(),
    arm: args.arm,
    plant: args.plant,
    scale: args.scale,
    quietMs: null,
    maxLoad: args.maxLoad,
    corpus: null,
    scenarios: args.scenarios,
    samples: args.samples,
    warmup: args.warmup,
    records: [],
  }
  const fail = (reason: string): void => {
    output.status = 'failed'
    output.failures.push(reason)
    console.error(`[browser] FAILED: ${reason}`)
  }
  const load0 = loadavg()[0] ?? 0
  if (load0 > args.maxLoad) {
    fail(`load ${load0.toFixed(2)} > ${args.maxLoad} before the run; nothing timed`)
    write(args.out, output)
    return 2
  }
  if (args.lease && !acquireBenchLease()) {
    throw new Error(
      '[browser] refusing to time without the bench lease (walls would be contaminated). Counts only.',
    )
  }
  let server: Server | null = null
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  output.browser = browser.version()
  try {
    server = await serveDist(args.serve, args.port)
    const page = await browser.newPage({ viewport: VIEWPORT })
    page.on('pageerror', (error) => fail(`page error: ${error.message}`))
    const plant = args.plant === null ? '' : `&plant=${encodeURIComponent(args.plant)}`
    const proof = `${args.check ? '&check=1' : ''}${args.offwindow ? '&offwindow=1' : ''}${args.markSettle ? '' : '&marksettle=0'}`
    const url = `http://127.0.0.1:${args.port}/${args.arm}.html?scale=${args.scale}&sha=${runtimeSha}${plant}${proof}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __proto?: { ready: boolean } }).__proto?.ready !== undefined,
      {},
      { timeout: 120_000 },
    )
    const ready = await page.evaluate(() => window.__proto.ready)
    if (!ready) {
      fail('page not ready (arm pending)')
      return 2
    }
    output.corpus = await page.evaluate(() => window.__proto.corpus)
    output.quietMs = await page.evaluate(() => window.__proto.quietMs)
    // Boot commits land before the first change, never in its record.
    await page.evaluate(() => window.__proto.settle())
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    const heap = async (): Promise<HeapUsage> => {
      await cdp.send('HeapProfiler.collectGarbage')
      return (await cdp.send('Runtime.getHeapUsage')) as HeapUsage
    }
    const rounds = args.warmup + args.samples
    for (let round = 0; round < rounds; round += 1) {
      const warmup = round < args.warmup
      // Warm-up rounds number -warmup..-1; measured samples 0..samples-1.
      const sample = round - args.warmup
      // Rotate the scenario order per round so drift hits every scenario.
      const order = args.scenarios.map(
        (_, i) => args.scenarios[(i + round) % args.scenarios.length] as ScenarioName,
      )
      for (const scenario of order) {
        let result: ProtoScenarioResult
        let heapBefore: HeapUsage
        let check: ProtoOracleCheck | null
        let parity: NonNullable<TimingRecord['parity']>
        try {
          // Pick and assert the drawn target (untimed), then the forced GC, then the change.
          await page.evaluate((name) => window.__proto.prepare(name), scenario)
          heapBefore = await heap()
          result = await page.evaluate((name) => window.__proto.runScenario(name), scenario)
          check = await page.evaluate(() => window.__proto.verify())
          // Untimed: the arm's output against the oracle's for the same state.
          parity = await page.evaluate(() => {
            const arm = window.__proto.snapshotHash()
            const oracle = window.__proto.oracleHash()
            return {
              arm,
              oracle,
              firstDifference: arm === oracle ? null : window.__proto.firstDifference(),
            }
          })
        } catch (error) {
          fail(`${scenario}#${sample}: ${(error as Error).message.split('\n')[0]}`)
          return 2
        }
        const load = loadavg()[0] ?? 0
        const record: TimingRecord = {
          arm: args.arm,
          plant: args.plant,
          scale: args.scale,
          scenario,
          sample,
          warmup,
          target: result.target,
          actionMs: result.actionMs,
          drainMs: result.drainMs,
          frameMs: result.frameMs,
          endedBy: result.endedBy,
          commits: result.commits,
          mounts: result.mounts,
          domMutations: result.domMutations,
          strayCommits: result.strayCommits,
          longTasks: result.longTasks.length,
          longTaskMs: result.longTasks.reduce((sum, t) => sum + t.duration, 0),
          heapBefore,
          heapAfter: await heap(),
          mountedRows: result.mountedRows,
          oracle:
            check === null
              ? null
              : {
                  changed: check.changed.length,
                  drawn: check.drawn.length,
                  over: check.over,
                  under: check.under,
                },
          parity,
          stats: result.stats,
          loadavg: load,
          uptime: uptime(),
          runtimeSha,
        }
        output.records.push(record)
        if (load > args.maxLoad)
          fail(`load ${load.toFixed(2)} > ${args.maxLoad} at ${scenario}#${sample}`)
        if (
          args.check &&
          check !== null &&
          CANDIDATE_ARMS.has(args.arm) &&
          (check.over.length > 0 || check.under.length > 0)
        ) {
          fail(
            `${scenario}#${sample}: target ${result.target} redrew [${check.drawn.join(',')}], the oracle changed [${check.changed.join(',')}]`,
          )
        }
        if (parity.arm !== parity.oracle && (args.strictParity || !PARITY_EXEMPT.has(args.arm))) {
          fail(
            `${scenario}#${sample}: parity — arm ${parity.arm} vs oracle ${parity.oracle}; first difference ${parity.firstDifference ?? '(hashes differ, no row differs)'}`,
          )
        }
        if (record.strayCommits > 0) {
          fail(
            `${scenario}#${sample}: ${record.strayCommits} commit signals landed after the previous settle (work deferred past ${output.quietMs} ms cannot be attributed)`,
          )
        }
        console.log(
          `[browser] ${args.arm}${args.plant ? `+${args.plant}` : ''} ${args.scale}x ${scenario}#${sample}${warmup ? ' (warm-up)' : ''}: ` +
            `actionMs=${record.actionMs.toFixed(2)} frameMs=${record.frameMs.toFixed(1)} ` +
            `by=${record.endedBy} commits=${record.commits} longTasks=${record.longTasks} ` +
            `stray=${record.strayCommits} target=${result.target} parity=${parity.arm === parity.oracle ? 'ok' : 'MISMATCH'}` +
            `${check === null ? '' : ` oracle=${check.changed.length} drawn=${check.drawn.length} over=${check.over.length} under=${check.under.length}`}` +
            ` load=${load.toFixed(2)}`,
        )
      }
    }
    return output.status === 'ok' ? 0 : 2
  } finally {
    write(args.out, output)
    console.log(`[browser] wrote ${args.out} (${output.records.length} records, ${output.status})`)
    await browser.close()
    server?.close()
    if (args.lease) releaseBenchLease()
  }
}

process.exitCode = await main()
