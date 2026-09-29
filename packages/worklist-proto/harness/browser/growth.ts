/**
 * POD-4747 — THE GROWTH TEST (replaces G6). G6 held cold start and heap to
 * 1.1x the legacy control; the operator rejected ratio budgets as arbitrary
 * (decision I4). This judges every arm against ITSELF as the workspace grows
 * along its two axes (`buildCorpusCell`, `harness/src/fixture/corpus.ts`):
 *
 * - HISTORY x10 at constant active work (`h1a1` → `h10a1`): the arm's retained
 *   heap and its cold start stay FLAT. Flat means the growth is within the
 *   noise of repeated runs: the tolerance of each check is the larger spread
 *   (max − min) of the per-round medians of the two cells it compares, read
 *   from the matrix's own rounds, never a constant.
 * - ACTIVE x4 at constant history (`h1a1` → `h1a4`): retained heap and cold
 *   start grow AT MOST LINEARLY (grown <= 4 × base + tolerance), and the
 *   per-change walls stay FLAT. A wall is judged as the arm's time above the
 *   no-op floor's in the same round (the floor carries the kernel write and
 *   the feed, the same for every arm). The floor's own wall is the kernel's
 *   and is reported under `engine`.
 * - A PRINCIPAL SWITCH is REPORTED, not judged: the heap a switch leaves
 *   against the heap a cold build leaves. The two pages differ by more than
 *   the arm (the floor's switched page holds 2.2 MB LESS than its cold page
 *   at 1x, POD-4747), so no tolerance from their spreads can call a
 *   difference a leak. The leak gate stays the driver's survivor check (no
 *   object of the old principal alive after a forced GC), which fails a run.
 *
 * The arm's retained heap is coldBootstrap's `heapAfter − heapBefore`
 * (forced GC both sides): what building the arm added over the booted page.
 * The booted page itself (`heapBefore`: fixture, durable cache, kernel
 * replica and runtime) and the kernel boot (`engineMs`) are reported under
 * `engine`, with the floor's walls: they grow with history by spec today (the client holds every
 * row; the memory cutoff is deferred), and `layers.ts` splits them by layer.
 *
 * A planted arm (`noop+hold:1`: one object per known issue) must fail the
 * history axis, or the summary says the plant was not caught.
 *
 * Refuses (exit 2) a directory that is not a complete `--cells` matrix: every
 * planned (round, arm, cell) run ok, every (arm, cell, scenario) at rounds ×
 * samples, one machine, one runtime SHA, at least three rounds (a tolerance
 * needs repeats), and the base cell with at least one grown cell. Exit 1
 * when an arm (not the engine, not a plant, not a report) fails a check, or a plant passes
 * every history check; 0 otherwise.
 *
 *   bun --conditions=@podium/source packages/worklist-proto/harness/browser/matrix.ts --host flatblock \
 *     --arms noop,control,mobx,noop+hold:1 --cells h1a1,h10a1,h1a4 --rounds 4 --samples 5 \
 *     --scenarios heartbeat,visibleHeartbeat,rename,stagemove,clock,click,coldBootstrap,principalSwitch \
 *     --tag growth
 *   bun --conditions=@podium/source packages/worklist-proto/harness/browser/growth.ts \
 *     packages/worklist-proto/harness/browser/results/growth [--json out.json]
 */
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { cellLabel, GROWTH_CELLS, parseCell } from '../src/fixture/index'
import { matrixRunFile } from './complete'
import { type RunOutput, SCENARIOS, type TimingRecord } from './records'
import { loadRuns } from './summarize'

/** A tolerance is a spread of repeated runs: fewer rounds than this have none worth the name. */
export const MIN_ROUNDS = 3

const BASE = cellLabel(GROWTH_CELLS.base)
const HISTORY = cellLabel(GROWTH_CELLS.history10)
const ACTIVE = cellLabel(GROWTH_CELLS.active4)

/** The metrics read off each measured record, by name. */
function metricsOf(record: TimingRecord): Record<string, number> {
  const mb = (bytes: number): number => bytes / 1e6
  const out: Record<string, number> = {}
  if (record.scenario === 'coldBootstrap') {
    out['cold start ms'] = record.actionMs
    if (record.heapBefore && record.heapAfter) {
      out['arm heap MB'] = mb(record.heapAfter.usedSize - record.heapBefore.usedSize)
      out['page heap MB'] = mb(record.heapAfter.usedSize)
      out['engine heap MB'] = mb(record.heapBefore.usedSize)
    }
    const engineMs = record.lifecycle?.phases['engineMs']
    if (engineMs !== undefined) out['engine boot ms'] = engineMs
  } else if (record.scenario === 'principalSwitch') {
    out['switch ms'] = record.actionMs
    if (record.heapAfter) out['switch heap MB'] = mb(record.heapAfter.usedSize)
  } else {
    out[`${record.scenario} ms`] = record.actionMs
  }
  return out
}

/** One (arm label, cell, metric): its median over every measured sample and per round. */
export interface Series {
  label: string
  cell: string
  metric: string
  n: number
  median: number
  roundMedians: number[]
  /** max − min of the round medians: how far repeated runs of the same cell move. */
  spread: number
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

const labelOf = (r: { arm: string; plant: string | null }): string =>
  r.plant ? `${r.arm}+${r.plant}` : r.arm

/** The round a matrix output belongs to, from its file name (`r2-mobx-h10a1.json`). */
function roundOf(file: string): number {
  const match = /^r(\d+)-/.exec(basename(file))
  if (match === null) throw new Error(`${file} is not a matrix run file`)
  return Number(match[1])
}

export function growthSeries(runs: RunOutput[], files: string[]): Series[] {
  const values = new Map<string, Map<number, number[]>>()
  runs.forEach((run, k) => {
    const round = roundOf(files[k] as string)
    for (const record of run.records) {
      if (record.warmup) continue
      for (const [metric, value] of Object.entries(metricsOf(record))) {
        const key = `${labelOf(record)}|${record.cell ?? `${record.scale}x`}|${metric}`
        const byRound = values.get(key) ?? new Map<number, number[]>()
        byRound.set(round, [...(byRound.get(round) ?? []), value])
        values.set(key, byRound)
      }
    }
  })
  return [...values.entries()].map(([key, byRound]) => {
    const [label, cell, metric] = key.split('|') as [string, string, string]
    const rounds = [...byRound.keys()].sort((a, b) => a - b)
    const roundMedians = rounds.map((r) => median(byRound.get(r) as number[]))
    const all = rounds.flatMap((r) => byRound.get(r) as number[])
    return {
      label,
      cell,
      metric,
      n: all.length,
      median: median(all),
      roundMedians,
      spread: Math.max(...roundMedians) - Math.min(...roundMedians),
    }
  })
}

export type GrowthCheck = 'history flat' | 'active linear' | 'active flat' | 'switch vs cold'

export interface GrowthVerdict {
  label: string
  check: GrowthCheck
  metric: string
  from: string
  to: string
  base: number
  grown: number
  /** The larger spread of the two cells' round medians. */
  tolerance: number
  /** What `grown` may reach. */
  bound: number
  pass: boolean
  /** `engine` rows, plants and reports are printed; only arms decide the exit code. */
  role: 'arm' | 'engine' | 'plant' | 'report'
}

const roleOf = (label: string): GrowthVerdict['role'] => (label.includes('+') ? 'plant' : 'arm')

/**
 * Every check the grid supports. `series` from `growthSeries`; the no-op
 * floor (`noop`) must be present for the wall checks.
 */
export function growthVerdicts(series: Series[]): GrowthVerdict[] {
  const find = (label: string, cell: string, metric: string): Series | undefined =>
    series.find((s) => s.label === label && s.cell === cell && s.metric === metric)
  const labels = [...new Set(series.map((s) => s.label))].sort()
  const cells = new Set(series.map((s) => s.cell))
  const out: GrowthVerdict[] = []
  const judge = (
    label: string,
    role: GrowthVerdict['role'],
    check: GrowthCheck,
    metric: string,
    from: string,
    to: string,
    base: { median: number; spread: number },
    grown: { median: number; spread: number },
    factor: number,
  ): void => {
    const tolerance = Math.max(base.spread, grown.spread)
    const bound = factor * base.median + tolerance
    out.push({
      label,
      check,
      metric,
      from,
      to,
      base: base.median,
      grown: grown.median,
      tolerance,
      bound,
      pass: grown.median <= bound,
      role,
    })
  }
  /** The arm's time above the floor's, round by round (same cell, same round). */
  const excess = (label: string, cell: string, metric: string) => {
    const arm = find(label, cell, metric)
    const floor = find('noop', cell, metric)
    if (arm === undefined || floor === undefined) return undefined
    const perRound = arm.roundMedians.map((m, r) => m - (floor.roundMedians[r] ?? Number.NaN))
    return {
      median: median(perRound),
      spread: Math.max(...perRound) - Math.min(...perRound),
    }
  }
  const walls = SCENARIOS.map((scenario) => `${scenario} ms`)
  for (const label of labels) {
    const role = roleOf(label)
    for (const [to, check, factor] of [
      [HISTORY, 'history flat', 1],
      [ACTIVE, 'active linear', parseCell(ACTIVE).active],
    ] as const) {
      if (!cells.has(to)) continue
      for (const metric of ['arm heap MB', 'cold start ms']) {
        const base = find(label, BASE, metric)
        const grown = find(label, to, metric)
        if (base && grown) judge(label, role, check, metric, BASE, to, base, grown, factor)
      }
      // Walls: flat on both axes (the active axis is the gate the brief names;
      // the history axis is judged the same way and reported).
      for (const metric of walls) {
        const wallCheck: GrowthCheck = to === HISTORY ? 'history flat' : 'active flat'
        if (label === 'noop') {
          const base = find(label, BASE, metric)
          const grown = find(label, to, metric)
          // The floor's wall is the kernel write and the feed: the engine's.
          if (base && grown) judge(label, 'engine', wallCheck, metric, BASE, to, base, grown, 1)
        } else if (role === 'arm') {
          const base = excess(label, BASE, metric)
          const grown = excess(label, to, metric)
          if (base && grown)
            judge(label, role, wallCheck, `${metric} over floor`, BASE, to, base, grown, 1)
        }
      }
    }
    for (const cell of [...cells].sort()) {
      const cold = find(label, cell, 'page heap MB')
      const switched = find(label, cell, 'switch heap MB')
      if (cold && switched)
        judge(label, 'report', 'switch vs cold', 'switch heap MB', cell, cell, cold, switched, 1)
    }
  }
  // The booted page before any arm (fixture, cache, kernel replica, runtime):
  // the same for every arm, reported from the floor's pages.
  for (const [to, check, factor] of [
    [HISTORY, 'history flat', 1],
    [ACTIVE, 'active linear', parseCell(ACTIVE).active],
  ] as const) {
    for (const metric of ['engine heap MB', 'engine boot ms']) {
      const base = find('noop', BASE, metric)
      const grown = find('noop', to, metric)
      if (base && grown) judge('engine', 'engine', check, metric, BASE, to, base, grown, factor)
    }
  }
  return out
}

/** Why a set of runs is not a complete `--cells` matrix (empty when it is). */
export function growthShortfalls(
  runs: RunOutput[],
  files: string[],
  plan:
    | { arms: string[]; cells?: string[]; rounds: number; samples: number; scenarios: string[] }
    | undefined,
): string[] {
  const out: string[] = []
  if (plan === undefined || (plan.cells?.length ?? 0) === 0)
    return ['no --cells matrix plan (matrix-plan.json with cells)']
  const cells = plan.cells as string[]
  if (!cells.includes(BASE)) out.push(`plan omits the base cell ${BASE}`)
  if (!cells.includes(HISTORY) && !cells.includes(ACTIVE))
    out.push(`plan has no grown cell (${HISTORY} or ${ACTIVE})`)
  if (!plan.arms.includes('noop')) out.push('plan omits the no-op floor')
  if (plan.rounds < MIN_ROUNDS)
    out.push(`plan has ${plan.rounds} rounds: a tolerance needs at least ${MIN_ROUNDS}`)
  const have = new Set(files.map((f) => basename(f)))
  for (let round = 0; round < plan.rounds; round += 1)
    for (const arm of plan.arms)
      for (const cell of cells) {
        const file = matrixRunFile(round, arm, cell)
        if (!have.has(file)) out.push(`run ${file}: no ok output`)
      }
  const counts = new Map<string, number>()
  for (const run of runs)
    for (const record of run.records) {
      if (record.warmup) continue
      const key = `${labelOf(record)}|${record.cell ?? '-'}|${record.scenario}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  const want = plan.rounds * plan.samples
  for (const arm of plan.arms)
    for (const cell of cells)
      for (const scenario of plan.scenarios) {
        const n = counts.get(`${arm}|${cell}|${scenario}`) ?? 0
        if (n !== want) out.push(`cell ${arm} ${cell} ${scenario}: ${n} of ${want} samples`)
      }
  const hosts = [...new Set(runs.map((r) => r.host ?? 'unrecorded'))]
  if (hosts.length > 1) out.push(`machines differ: ${hosts.join(', ')}`)
  const shas = [...new Set(runs.map((r) => r.runtimeSha))]
  if (shas.length > 1) out.push(`runtime SHAs differ: ${shas.join(', ')}`)
  return out
}

const f = (v: number, digits = 2): string => v.toFixed(digits)

export function runGrowth(argv: string[], print: (line: string) => void): number {
  const jsonIndex = argv.indexOf('--json')
  const jsonOut = jsonIndex >= 0 ? argv[jsonIndex + 1] : undefined
  const paths = argv.filter((_, i) => jsonIndex < 0 || (i !== jsonIndex && i !== jsonIndex + 1))
  const { ok, okFiles, failed, plans } = loadRuns(paths)
  for (const { path, run } of failed)
    print(`FAILED RUN (listed, not summarised): ${path} — ${run.failures.join('; ')}`)
  if (plans.length !== 1) {
    print(`NOT ONE MATRIX (not summarised): ${plans.length} plans`)
    return 2
  }
  const shortfalls = growthShortfalls(ok, okFiles, plans[0])
  if (shortfalls.length > 0) {
    for (const s of shortfalls) print(`INCOMPLETE (not summarised): ${s}`)
    return 2
  }
  const series = growthSeries(ok, okFiles)
  const verdicts = growthVerdicts(series)
  const loads = ok.flatMap((r) => r.records.map((x) => x.loadavg))
  print(
    `host ${ok[0]?.host ?? '?'}; runtimeSha ${ok[0]?.runtimeSha ?? '?'}; ${ok.length} ok runs; ` +
      `${plans[0]?.rounds} rounds x ${plans[0]?.samples} samples; load per record ${f(Math.min(...loads))}–${f(Math.max(...loads))}`,
  )
  const cells = plans[0]?.cells ?? []
  const labels = [...new Set(series.map((s) => s.label))].sort()
  const metrics = [...new Set(series.map((s) => s.metric))]
  print('')
  print(`| Arm | Metric | ${cells.map((c) => `${c} median (round spread)`).join(' | ')} |`)
  print(`|---|---|${cells.map(() => '---').join('|')}|`)
  for (const label of labels)
    for (const metric of metrics) {
      const row = cells.map((cell) => {
        const s = series.find((x) => x.label === label && x.cell === cell && x.metric === metric)
        return s === undefined ? '—' : `${f(s.median)} (${f(s.spread)})`
      })
      if (row.every((cell) => cell === '—')) continue
      print(`| ${label} | ${metric} | ${row.join(' | ')} |`)
    }
  print('')
  print('| Arm | Check | Metric | Cells | base → grown | x | tolerance | bound | verdict |')
  print('|---|---|---|---|---|---|---|---|---|')
  for (const v of verdicts) {
    const ratio = v.base !== 0 ? f(v.grown / v.base) : '—'
    const word = v.pass
      ? v.check === 'active linear'
        ? 'linear'
        : v.check === 'switch vs cold'
          ? 'at or below'
          : 'flat'
      : v.check === 'active linear'
        ? 'SUPERLINEAR'
        : v.check === 'switch vs cold'
          ? 'ABOVE'
          : 'GROWS'
    print(
      `| ${v.label} | ${v.check} | ${v.metric} | ${v.from === v.to ? v.from : `${v.from} → ${v.to}`} | ` +
        `${f(v.base)} → ${f(v.grown)} | ${ratio} | ${f(v.tolerance)} | ${f(v.bound)} | ${word} |`,
    )
  }
  const armFailures = verdicts.filter((v) => v.role === 'arm' && !v.pass)
  const uncaught = [
    ...new Set(verdicts.filter((v) => v.role === 'plant').map((v) => v.label)),
  ].filter((plant) =>
    verdicts.every((v) => v.label !== plant || v.check !== 'history flat' || v.pass),
  )
  print('')
  for (const plant of uncaught) print(`PLANT NOT CAUGHT: ${plant} passes every history check`)
  print(
    `arms failing a check: ${[...new Set(armFailures.map((v) => v.label))].join(', ') || 'none'}`,
  )
  if (jsonOut !== undefined)
    writeFileSync(
      jsonOut,
      JSON.stringify({ runtimeSha: ok[0]?.runtimeSha, series, verdicts }, null, 2),
    )
  return armFailures.length > 0 || uncaught.length > 0 ? 1 : 0
}

if (import.meta.main) process.exitCode = runGrowth(process.argv.slice(2), console.log)
