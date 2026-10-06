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
 * dispatch is the engine selection write (POD-4559). There is no task-time
 * metric: no poll, no frame wait inside any budgeted number. Around the page call the driver adds
 * heap before/after (CDP, forced GC), loadavg and uptime per record, and the
 * runtime SHA.
 *
 * LIFECYCLE (POD-4561, L5e; methodology #11-#13). `--scenarios` may name
 * `coldBootstrap`, `principalSwitch` and `rescope` (never in the default set;
 * timed at 1x, rescope refuses 4x). Each lifecycle sample, warm-ups included,
 * loads its OWN page in a fresh browser context (`?hold=1`: the engine boots,
 * the arm waits): a killed or repeated lifecycle step poisons later renders
 * in the same page, and a fresh renderer gives each sample its own heap. The
 * page's timer is the hot path's. coldBootstrap times the arm's build and
 * first list (`actionMs` = the entry's own load plus that window; the shared
 * fixture and engine boot are reported as `engineMs`); principalSwitch times
 * dispose + rebuild over a fresh replica booted untimed for the next
 * principal; rescope times the install onto the 2x corpus plus the install
 * back. The forced-GC heap brackets each step (`heapBefore`: engine booted,
 * no arm / the built arm with the next runtime or the 2x rows staged;
 * `heapAfter`: after the step). The run FAILS on a parity mismatch after the
 * step or at the grown state, on commit signals outside the step's window,
 * and when any object of the old principal survives the switch's forced GC
 * (`survivors`: runtime, store, replica, cache, arm handle, row source).
 *
 * PARITY (POD-4559). After every sample, outside the timed window, the driver
 * compares the page's `snapshotHash()` (the arm's slice output) with its
 * `oracleHash()` (the oracle over the same engine state); a mismatch fails
 * the run and names the first differing row. The no-op floor draws a frozen
 * boot snapshot by design and is exempt unless `--strict-parity` (the proof
 * that the comparison fails a wrong arm).
 *
 * A run FAILS (status `failed`, exit 2) when the 1-minute load is above
 * `--max-load` (default and ceiling 8) before it or at any record, when any
 * cell errors or is short of its planned records (POD-4562: a missing cell
 * fails the run, it is never withheld or provisional), on a parity mismatch,
 * or on stray commits. A failed run writes NO results file: its records go to
 * `<out>.failed.json` for diagnosis, and any earlier file at `--out` is
 * removed first. `--dry-run` prints the plan and exits without a browser.
 *
 * CELLS (POD-4747). `--cell h10a1` loads the two-axis corpus cell instead of
 * a scale (`buildCorpusCell`: history x10, active x1); the page's scale is
 * the cell's active factor. Every scenario runs on a cell except rescope (a
 * scope change onto the legacy 2x corpus, not growth).
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
 *   bun scripts/test-heavy.ts -- bun --conditions=@podium/source tests/worklist/harness/browser/run.ts \
 *     --arm noop --scale 1 --samples 5 --out tests/worklist/harness/browser/results/noop-1x.json
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { hostname, loadavg, uptime } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { cellLabel, parseCell } from '../src/fixture/index'
import type {
  ProtoLifecycleResult,
  ProtoOracleCheck,
  ProtoParity,
  ProtoScenarioResult,
} from '../web/entrylib'
import {
  checkMaxLoad,
  describePlan,
  failedPathFor,
  MAX_LOAD,
  plannedRounds,
  runShortfalls,
} from './complete'
import { truthRows } from './grown-truth'
import {
  ALL_SCENARIOS,
  CAPTURE_ARMS,
  type ArmName,
  type HeapUsage,
  type HotPathScenario,
  isLifecycle,
  type LifecycleScenario,
  type RunOutput,
  SCENARIOS,
  type Scale,
  type ScenarioName,
  type TimingRecord,
} from './records'

/** One viewport for every arm and scale, tall enough that the first window
 *  (`FIRST_WINDOW_ROWS`, `entrylib.ts`) holds a drawn target for every
 *  scenario at 4x, below a pinned section that grows with the corpus (84 rows
 *  at 4x on the reshaped fixture: 96 rows of 56 px plus two 40 px headers is
 *  5,456 px; POD-4560). */
const VIEWPORT = { width: 1600, height: 5800 }
/** POD-4747: every two-axis cell page's viewport, the same at every cell (its
 *  124-row first window, `CELL_FIRST_WINDOW_ROWS` in `entrylib.ts`). Cell
 *  walls compare with each other, never with scale runs. */
const CELL_VIEWPORT = { width: 1600, height: 7400 }

/** The arms held to the oracle in check mode; the control (whole-list redraw)
 *  and the no-op page (draws nothing) exist to fail it and are reported only. */
const CANDIDATE_CAPTURE_ARMS = new Set<ArmName>(['hand', 'mobx', 'mobx-write', 'mobx-pending'])

/** The floor draws its boot snapshot forever: parity is reported, not enforced, unless `--strict-parity`. */
const PARITY_EXEMPT = new Set<ArmName>(['noop'])

/** principalSwitch: the page boots as `operator` and switches to this principal. */
const SWITCH_PRINCIPAL = 'operator-2'

/** rescope grows to twice the page's corpus and comes back; the fixture stops at 4x. */
function rescopeScale(scale: Scale): 2 | 4 {
  if (scale === 4) throw new Error('rescope grows to 2x the page corpus: run it at --scale 1 or 2')
  return scale === 1 ? 2 : 4
}

/**
 * POD-4715 — the grown state's true visible rows at `scale`: the fixture
 * oracle over the grown corpus (see `grown-truth.ts`). Every rescope record
 * must hold exactly this many grown rows (the floor draws its frozen boot
 * snapshot by design, so it holds the 1x truth instead); anything else FAILS
 * the run, because a control doing half the grown work understates the ratio
 * the arms are held to.
 */

interface OpenPage {
  page: Page
  /** Forced GC, then the V8 heap (CDP). */
  heap: () => Promise<HeapUsage>
  close: () => Promise<void>
}

/** What one scenario sample yields before it becomes a record. */
interface Sample {
  result: ProtoScenarioResult
  check: ProtoOracleCheck | null
  parity: ProtoParity
  heapBefore: HeapUsage
  heapAfter: HeapUsage
  lifecycle: TimingRecord['lifecycle']
}

interface Args {
  arm: ArmName
  scale: Scale
  /** POD-4747: the two-axis cell label, or null for a `--scale` run. */
  cell: string | null
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
  consolePlant: string | null
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(flag)
    if (index < 0 || index + 1 >= argv.length) return fallback
    return argv[index + 1]
  }
  const arm = (get('--arm', 'mobx') ?? 'mobx') as string
  if (get('--plant') !== undefined && arm !== 'noop')
    throw new Error('--plant is for --arm noop only')
  if (!(CAPTURE_ARMS as readonly string[]).includes(arm)) {
    throw new Error(`--arm must be one of ${CAPTURE_ARMS.join(', ')} (got ${arm})`)
  }
  const rawCell = get('--cell')
  const cell = rawCell === undefined ? null : parseCell(rawCell)
  if (cell !== null && get('--scale') !== undefined)
    throw new Error('--cell and --scale are exclusive (a cell sets its own scale)')
  const scale = cell?.active ?? Number(get('--scale', '1'))
  if (scale !== 1 && scale !== 2 && scale !== 4)
    throw new Error(`--scale must be 1, 2 or 4 (got ${scale})`)
  const scenarios = ((get('--scenarios', SCENARIOS.join(',')) ?? '').split(',') as string[]).map(
    (s) => s.trim(),
  )
  for (const scenario of scenarios) {
    if (!(ALL_SCENARIOS as readonly string[]).includes(scenario)) {
      throw new Error(`unknown scenario ${scenario} (want ${ALL_SCENARIOS.join(', ')})`)
    }
  }
  if (scenarios.includes('rescope')) {
    if (cell !== null)
      throw new Error('rescope grows onto the legacy 2x corpus: never on a --cell run')
    rescopeScale(scale as Scale)
  }
  const consolePlant = get('--console-plant')
  if (
    consolePlant !== undefined &&
    (arm !== 'mobx' || !['warn', 'reaction'].includes(consolePlant))
  )
    throw new Error('--console-plant is warn or reaction, for --arm mobx only')
  const label = cell === null ? `${scale}x` : cellLabel(cell)
  return {
    arm: arm as ArmName,
    scale: scale as Scale,
    cell: cell === null ? null : cellLabel(cell),
    scenarios: scenarios as ScenarioName[],
    // Per page load: each click takes a fresh mounted row (a window holds ~17).
    samples: Number(get('--samples', '5')),
    warmup: Number(get('--warmup', '1')),
    maxLoad: checkMaxLoad(Number(get('--max-load', String(MAX_LOAD)))),
    out: get('--out', `tests/worklist/harness/browser/results/${arm}-${label}.json`) ?? '',
    port: Number(get('--port', '8751')),
    serve: get('--serve', 'tests/worklist/harness/web/dist') ?? '',
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
    // Proof plant (POD-4572): the MobX page plants a console warning (`warn`)
    // or a reaction that throws (`reaction`) after boot; the console trap
    // must fail the run. Never a timing run.
    consolePlant: consolePlant ?? null,
    // Print the plan (rounds, rotated scenario order, what complete means) and exit.
    dryRun: argv.includes('--dry-run'),
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
    let file = join(dir, url.pathname === '/' ? 'mobx.html' : url.pathname.slice(1))
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

/**
 * The only writer of run output: a complete, passing run goes to `out`; any
 * other run (a failure, a short cell, a record over the load ceiling) goes to
 * `<out>.failed.json` and leaves no file at `out`.
 */
function finish(out: string, output: RunOutput): void {
  for (const shortfall of runShortfalls(output)) {
    if (!output.failures.includes(shortfall)) {
      output.status = 'failed'
      output.failures.push(shortfall)
      console.error(`[browser] FAILED: ${shortfall}`)
    }
  }
  const path = output.status === 'ok' ? out : failedPathFor(out)
  write(path, output)
  console.log(`[browser] wrote ${path} (${output.records.length} records, ${output.status})`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dryRun) {
    for (const line of describePlan(args, args.out)) console.log(line)
    return 0
  }
  // A results file at `out` must come from THIS run, and only if it completes.
  rmSync(args.out, { force: true })
  rmSync(failedPathFor(args.out), { force: true })
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
    cell: args.cell,
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
    finish(args.out, output)
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
    const plant = args.plant === null ? '' : `&plant=${encodeURIComponent(args.plant)}`
    const proof = `${args.check ? '&check=1' : ''}${args.offwindow ? '&offwindow=1' : ''}${args.markSettle ? '' : '&marksettle=0'}${args.consolePlant === null ? '' : `&consoleplant=${args.consolePlant}`}`
    const corpus = args.cell === null ? `scale=${args.scale}` : `cell=${args.cell}`
    const url = `http://127.0.0.1:${args.port}/${args.arm}.html?${corpus}&sha=${runtimeSha}${plant}${proof}`
    /**
     * One page load of the arm in its own browser context (a fresh renderer:
     * nothing cached, a heap of its own), booted and ready; null when the arm
     * is pending (the run has failed). `hold`: a lifecycle page, the arm
     * waiting for the driver.
     */
    const openPage = async (hold: boolean): Promise<OpenPage | null> => {
      const context = await browser.newContext({
        viewport: args.cell === null ? VIEWPORT : CELL_VIEWPORT,
      })
      const page = await context.newPage()
      page.on('pageerror', (error) => fail(`page error: ${error.message}`))
      // THE CONSOLE TRAP (POD-4572, M3 note N3): MobX reports a throw inside
      // a reaction through console.error, and its enforcement only warns, so
      // a candidate arm's run fails on any console warning or error. Other
      // pages' messages are printed, not failed.
      page.on('console', (message) => {
        const type = message.type()
        if (type !== 'warning' && type !== 'error') return
        const text = `console ${type}: ${message.text().slice(0, 300)}`
        if (CANDIDATE_CAPTURE_ARMS.has(args.arm)) fail(text)
        else console.log(`[browser] ${args.arm} ${text}`)
      })
      await page.goto(hold ? `${url}&hold=1` : url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        () => (window as unknown as { __proto?: { ready: boolean } }).__proto?.ready !== undefined,
        {},
        { timeout: 120_000 },
      )
      if (!(await page.evaluate(() => window.__proto.ready))) {
        fail('page not ready (arm pending)')
        await context.close()
        return null
      }
      output.quietMs = await page.evaluate(() => window.__proto.quietMs)
      const cdp = await context.newCDPSession(page)
      await cdp.send('HeapProfiler.enable')
      const heap = async (): Promise<HeapUsage> => {
        await cdp.send('HeapProfiler.collectGarbage')
        return (await cdp.send('Runtime.getHeapUsage')) as HeapUsage
      }
      return { page, heap, close: () => context.close() }
    }

    // The hot-path changes share one page (their order rotates per round);
    // every lifecycle sample loads its own (`lifecycleSample`).
    let hot: OpenPage | null = null
    if (args.scenarios.some((scenario) => !isLifecycle(scenario))) {
      hot = await openPage(false)
      if (hot === null) return 2
      const { page } = hot
      output.corpus = await page.evaluate(() => window.__proto.corpus)
      // Boot commits land before the first change, never in its record.
      await page.evaluate(() => window.__proto.settle())
    }

    /** A hot-path change on the shared page: pick and assert the drawn target
     *  (untimed), the forced GC, the change, then the untimed checks. */
    const hotSample = async (open: OpenPage, scenario: HotPathScenario): Promise<Sample> => {
      const { page, heap } = open
      await page.evaluate((name) => window.__proto.prepare(name), scenario)
      const heapBefore = await heap()
      const result = await page.evaluate((name) => window.__proto.runScenario(name), scenario)
      const check = await page.evaluate(() => window.__proto.verify())
      // Untimed: the arm's output against the oracle's for the same state.
      const parity = await page.evaluate(() => {
        const arm = window.__proto.snapshotHash()
        const oracle = window.__proto.oracleHash()
        return {
          arm,
          oracle,
          firstDifference: arm === oracle ? null : window.__proto.firstDifference(),
        }
      })
      return { result, check, parity, heapBefore, heapAfter: await heap(), lifecycle: undefined }
    }

    /**
     * POD-4561 (L5e): one lifecycle sample on a fresh held page. The forced-GC
     * heap brackets the timed step: coldBootstrap from the booted engine with
     * no arm to the drawn list; principalSwitch from the built arm (the next
     * principal's runtime already booted) to the rebuilt one, the old runtime
     * destroyed; rescope from the built arm (the 2x rows staged) to the
     * install back. Late commit signals after the step count as strays.
     */
    const lifecycleSample = async (scenario: LifecycleScenario): Promise<Sample> => {
      const open = await openPage(true)
      if (open === null) throw new Error('page not ready (arm pending)')
      const { page, heap } = open
      try {
        let heapBefore: HeapUsage
        let result: ProtoLifecycleResult
        if (scenario === 'coldBootstrap') {
          heapBefore = await heap()
          result = await page.evaluate(() => window.__proto.coldBootstrap())
        } else if (scenario === 'principalSwitch') {
          await page.evaluate(() => window.__proto.build())
          await page.evaluate((p) => window.__proto.prepareRebuild(p), SWITCH_PRINCIPAL)
          heapBefore = await heap()
          result = await page.evaluate((p) => window.__proto.rebuild(p), SWITCH_PRINCIPAL)
        } else {
          const to = rescopeScale(args.scale)
          await page.evaluate(() => window.__proto.build())
          await page.evaluate((s) => window.__proto.prepareRescope(s), to)
          heapBefore = await heap()
          result = await page.evaluate((s) => window.__proto.rescope(s), to)
          // POD-4715: every page must reach the same grown state. The arms
          // and the control hold the grown truth; the floor draws its frozen
          // boot snapshot by design and holds the 1x truth. Anything else
          // FAILS the run (a missing or half grown state understates the
          // ratio the arms are held to).
          const wantGrownRows = args.arm === 'noop' ? truthRows(args.scale) : truthRows(to)
          const gotGrownRows = (result.phases as { grownRows?: unknown }).grownRows
          if (gotGrownRows !== wantGrownRows) {
            fail(
              `rescope grown rows ${String(gotGrownRows)} !== ${wantGrownRows} on ${args.arm} (POD-4715: every page must reach the same grown state)`,
            )
          }
        }
        const heapAfter = await heap()
        output.corpus ??= await page.evaluate(() => window.__proto.corpus)
        const parity = await page.evaluate(() => ({
          arm: window.__proto.snapshotHash(),
          oracle: window.__proto.oracleHash(),
          firstDifference: window.__proto.firstDifference(),
        }))
        const late = await page.evaluate(() => window.__proto.lateSignals())
        // After `heapAfter`'s forced GC: nothing of the old principal may be alive.
        const survivors = await page.evaluate(() => window.__proto.survivors())
        return {
          result: { ...result, strayCommits: result.strayCommits + late },
          check: null,
          parity,
          heapBefore,
          heapAfter,
          lifecycle: { phases: result.phases, midParity: result.midParity, survivors },
        }
      } finally {
        await open.close()
      }
    }

    // The same rounds `--dry-run` prints (`complete.ts`).
    for (const { sample, warmup, order } of plannedRounds(args)) {
      for (const scenario of order) {
        let taken: Sample
        try {
          taken = isLifecycle(scenario)
            ? await lifecycleSample(scenario)
            : await hotSample(hot as OpenPage, scenario)
        } catch (error) {
          fail(`${scenario}#${sample}: ${(error as Error).message.split('\n')[0]}`)
          return 2
        }
        const { result, check, parity } = taken
        const load = loadavg()[0] ?? 0
        const record: TimingRecord = {
          arm: args.arm,
          plant: args.plant,
          scale: args.scale,
          cell: args.cell,
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
          heapBefore: taken.heapBefore,
          heapAfter: taken.heapAfter,
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
          ...(taken.lifecycle === undefined ? {} : { lifecycle: taken.lifecycle }),
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
          CANDIDATE_CAPTURE_ARMS.has(args.arm) &&
          (check.over.length > 0 || check.under.length > 0)
        ) {
          fail(
            `${scenario}#${sample}: target ${result.target} redrew [${check.drawn.join(',')}], the oracle changed [${check.changed.join(',')}]`,
          )
        }
        const held = args.strictParity || !PARITY_EXEMPT.has(args.arm)
        if (parity.arm !== parity.oracle && held) {
          fail(
            `${scenario}#${sample}: parity — arm ${parity.arm} vs oracle ${parity.oracle}; first difference ${parity.firstDifference ?? '(hashes differ, no row differs)'}`,
          )
        }
        const mid = taken.lifecycle?.midParity ?? null
        if (mid !== null && mid.arm !== mid.oracle && held) {
          fail(
            `${scenario}#${sample}: parity at the grown state — arm ${mid.arm} vs oracle ${mid.oracle}; first difference ${mid.firstDifference ?? '(hashes differ, no row differs)'}`,
          )
        }
        if ((taken.lifecycle?.survivors.length ?? 0) > 0) {
          fail(
            `${scenario}#${sample}: after the switch and a forced GC the old principal's ${taken.lifecycle?.survivors.join(', ')} still alive (retained by the page or the arm)`,
          )
        }
        if (record.strayCommits > 0) {
          fail(
            `${scenario}#${sample}: ${record.strayCommits} commit signals landed outside the step's window (work deferred past ${output.quietMs} ms cannot be attributed)`,
          )
        }
        const phases =
          taken.lifecycle === undefined
            ? ''
            : ` ${Object.entries(taken.lifecycle.phases)
                .map(([k, v]) => `${k}=${v.toFixed(1)}`)
                .join(
                  ' ',
                )} heap=${((taken.heapBefore?.usedSize ?? 0) / 1e6).toFixed(1)}->${((taken.heapAfter?.usedSize ?? 0) / 1e6).toFixed(1)}MB`
        console.log(
          `[browser] ${args.arm}${args.plant ? `+${args.plant}` : ''} ${args.cell ?? `${args.scale}x`} ${scenario}#${sample}${warmup ? ' (warm-up)' : ''}: ` +
            `actionMs=${record.actionMs.toFixed(2)} frameMs=${record.frameMs.toFixed(1)} ` +
            `by=${record.endedBy} commits=${record.commits} longTasks=${record.longTasks} ` +
            `stray=${record.strayCommits} target=${result.target} parity=${parity.arm === parity.oracle ? 'ok' : 'MISMATCH'}` +
            `${check === null ? '' : ` oracle=${check.changed.length} drawn=${check.drawn.length} over=${check.over.length} under=${check.under.length}`}` +
            `${phases} load=${load.toFixed(2)}`,
        )
      }
    }
    await hot?.close()
  } finally {
    finish(args.out, output)
    await browser.close()
    server?.close()
    if (args.lease) releaseBenchLease()
  }
  return output.status === 'ok' ? 0 : 2
}

process.exitCode = await main()
