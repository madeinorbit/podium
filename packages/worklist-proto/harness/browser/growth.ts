/**
 * POD-4747 — THE GROWTH TEST (replaces G6). G6 held cold start and heap to
 * 1.1x the legacy control; the operator rejected ratio budgets as arbitrary
 * (decision I4). This judges every arm against ITSELF as the workspace grows
 * along its two axes (`buildCorpusCell`, `harness/src/fixture/corpus.ts`):
 *
 * - HISTORY x10 at constant active work (`h1a1` → `h10a1`): the arm's retained
 *   heap and its cold start stay FLAT. Flat means the growth is within the
 *   noise of repeated runs, read from the matrix's own rounds, never a
 *   constant (TOLERANCES, below).
 * - ACTIVE x4 at constant history (`h1a1` → `h1a4`): retained heap and cold
 *   start grow AT MOST LINEARLY (grown <= 4 × base + tolerance), and the
 *   per-change walls stay FLAT. A wall is judged as the arm's time above the
 *   no-op floor's in the same round (the floor carries the kernel write and
 *   the feed, the same for every arm). The floor's own wall is the kernel's
 *   and is reported under `engine`.
 *
 * TOLERANCES (POD-4825). A HEAP check's tolerance is the larger spread
 * (max − min) of the two cells' round medians: a forced-GC heap barely moves
 * between rounds (hundredths of a MB), so that spread is already sharp. A
 * TIME check (cold start, every wall) is paired by round: round r's growth is
 * `grown_r − factor × base_r` (for a wall, each side above the floor's same
 * round), and the tolerance is the one-sided {@link TIME_CONFIDENCE} Student-t
 * bound on the mean of those growths, `t × sd / √rounds`. The spread of round
 * medians it replaces only widens as rounds are added and was set by the one
 * slow round of each cell (cold start 493 ms on a 652 ms base; walls 30–200
 * ms on an arm's own 0.2–7 ms): no doubling could fail it. The paired bound
 * shrinks with every round, and round effects both cells share cancel.
 *
 * WHAT A CHECK CAN SEE. A time check whose tolerance is at least `factor ×
 * base` cannot tell a doubling of the arm's own time from noise: its pass
 * is printed `blind`, never `flat`, with the rounds a matrix would need
 * (at this noise) to see one. A blind check never fails; it is not evidence
 * of flatness either. The planted slow arm (`noop+double:<ms>`: `ms` per
 * change and per build on the base cell, twice that on a grown one) must
 * fail a time check, or the summary says the plant was not caught.
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
 * THE ENGINE GATE (POD-4825, off today). The booted page grows with history
 * by spec until the memory cutoff lands (21 → 97 MB at history x10), so the
 * `engine` rows are printed and never decide the exit code. `--engine-gate`
 * makes them a gate: an engine check that fails exits 1 like an arm's. The
 * memory-cutoff work turns it on.
 *
 * Refuses (exit 2) a directory that is not a complete `--cells` matrix: every
 * planned (round, arm, cell) run ok, every (arm, cell, scenario) at rounds ×
 * samples, one machine, one runtime SHA, at least three rounds (a tolerance
 * needs repeats), and the base cell with at least one grown cell. Exit 1
 * when an arm (not a plant, not a report; the engine only with
 * `--engine-gate`) fails a check, or a plant passes every check it must fail;
 * 0 otherwise.
 *
 *   bun --conditions=@podium/source packages/worklist-proto/harness/browser/matrix.ts --host flatblock \
 *     --arms noop,control,mobx,noop+hold:1 --cells h1a1,h10a1,h1a4 --rounds 4 --samples 5 \
 *     --scenarios heartbeat,visibleHeartbeat,rename,stagemove,clock,click,coldBootstrap,principalSwitch \
 *     --tag growth
 *   bun --conditions=@podium/source packages/worklist-proto/harness/browser/growth.ts \
 *     packages/worklist-proto/harness/browser/results/growth [--json out.json] [--engine-gate]
 */
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { cellLabel, GROWTH_CELLS, parseCell } from '../src/fixture/index'
import { matrixRunFile } from './complete'
import { type RunOutput, SCENARIOS, type TimingRecord } from './records'
import { loadRuns } from './summarize'

/** A tolerance is a spread of repeated runs: fewer rounds than this have none worth the name. */
export const MIN_ROUNDS = 3

/**
 * POD-4825: the one-sided confidence of a time check's bound. A matrix judges
 * about fourteen time checks per arm; at 99 % a truly flat arm fails one by
 * chance in roughly one run of eight, at 95 % in every other run.
 */
export const TIME_CONFIDENCE = 0.99

/** One-sided 99 % quantiles of Student's t by degrees of freedom (1–30); beyond, the normal's. */
const T99: readonly number[] = [
  31.821, 6.965, 4.541, 3.747, 3.365, 3.143, 2.998, 2.896, 2.821, 2.764, 2.7181, 2.681, 2.65, 2.624,
  2.602, 2.583, 2.567, 2.552, 2.539, 2.528, 2.518, 2.508, 2.5, 2.492, 2.485, 2.479, 2.473, 2.467,
  2.462, 2.457,
]

/** The one-sided {@link TIME_CONFIDENCE} quantile of Student's t with `df` degrees of freedom. */
export function tQuantile(df: number): number {
  if (!Number.isInteger(df) || df < 1)
    throw new Error(`[growth] t quantile needs df >= 1 (got ${df})`)
  return T99[df - 1] ?? 2.326
}

function sampleSd(values: readonly number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1))
}

/**
 * A time check's tolerance: the one-sided t bound on the mean of the paired
 * round growths `grown_r − factor × base_r` (see TOLERANCES in the module note).
 */
export function pairedTolerance(
  base: readonly number[],
  grown: readonly number[],
  factor: number,
): number {
  if (base.length !== grown.length || base.length < 2) {
    throw new Error(
      `[growth] a paired tolerance needs the same rounds on both cells, at least two (got ${base.length} and ${grown.length})`,
    )
  }
  const growth = grown.map((g, r) => g - factor * (base[r] as number))
  return (tQuantile(growth.length - 1) * sampleSd(growth)) / Math.sqrt(growth.length)
}

/**
 * The rounds a paired time check needs, at the noise it saw, before its
 * tolerance drops under `margin` (the growth it must see); null past 1000.
 */
export function roundsToSee(
  base: readonly number[],
  grown: readonly number[],
  factor: number,
  margin: number,
): number | null {
  const sd = sampleSd(grown.map((g, r) => g - factor * (base[r] as number)))
  for (let n = 2; n <= 1000; n += 1) if ((tQuantile(n - 1) * sd) / Math.sqrt(n) < margin) return n
  return null
}

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
  /**
   * A heap check's: the larger spread of the two cells' round medians. A
   * time check's: the paired t bound (TOLERANCES in the module note).
   */
  tolerance: number
  /** What `grown` may reach. */
  bound: number
  pass: boolean
  /**
   * `engine` rows, plants and reports are printed; arms decide the exit code
   * (and the engine too, with `--engine-gate`).
   */
  role: 'arm' | 'engine' | 'plant' | 'report'
  /** POD-4825: `time` checks are paired by round; `heap` checks read the spread. */
  kind: 'heap' | 'time'
  /**
   * A time check that cannot see a doubling (`tolerance >= factor × base`):
   * the rounds it would need at this noise (null: none within 1000). Absent
   * on heap checks and on time checks that can see one.
   */
  blind?: { roundsToSee: number | null }
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
    base: { median: number; spread: number; roundMedians: number[] },
    grown: { median: number; spread: number; roundMedians: number[] },
    factor: number,
  ): void => {
    const kind: GrowthVerdict['kind'] = / ms( |$)/.test(metric) ? 'time' : 'heap'
    const tolerance =
      kind === 'heap'
        ? Math.max(base.spread, grown.spread)
        : pairedTolerance(base.roundMedians, grown.roundMedians, factor)
    const bound = factor * base.median + tolerance
    const margin = factor * Math.abs(base.median)
    const blind =
      kind === 'time' && tolerance >= margin
        ? { roundsToSee: roundsToSee(base.roundMedians, grown.roundMedians, factor, margin) }
        : undefined
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
      kind,
      ...(blind === undefined ? {} : { blind }),
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
      roundMedians: perRound,
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
        } else {
          // Arms, and plants (a slow plant must fail a wall: POD-4825).
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
  // POD-4825: the engine rows decide the exit code only when asked (off today).
  const engineGate = argv.includes('--engine-gate')
  const paths = argv.filter(
    (arg, i) =>
      arg !== '--engine-gate' && (jsonIndex < 0 || (i !== jsonIndex && i !== jsonIndex + 1)),
  )
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
      ? v.blind !== undefined
        ? `blind (sees a doubling at ${v.blind.roundsToSee ?? '>1000'} rounds)`
        : v.check === 'active linear'
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
  const engineFailures = verdicts.filter((v) => v.role === 'engine' && !v.pass)
  const uncaught = [
    ...new Set(verdicts.filter((v) => v.role === 'plant').map((v) => v.label)),
  ].filter((plant) => !plantCaught(verdicts, plant))
  const blind = verdicts.filter((v) => v.role === 'arm' && v.blind !== undefined)
  print('')
  for (const plant of uncaught) print(`PLANT NOT CAUGHT: ${plant} passes every check it must fail`)
  if (blind.length > 0)
    print(
      `cannot see a doubling (noise above the arm's own time; not evidence of flatness): ${blind
        .map((v) => `${v.label} ${v.check} ${v.metric}`)
        .join('; ')}`,
    )
  print(
    `arms failing a check: ${[...new Set(armFailures.map((v) => v.label))].join(', ') || 'none'}`,
  )
  print(
    `engine gate: ${engineGate ? 'ON' : 'off (reported only; --engine-gate)'}; engine checks failing: ` +
      `${engineFailures.map((v) => `${v.label} ${v.check} ${v.metric}`).join('; ') || 'none'}`,
  )
  if (jsonOut !== undefined)
    writeFileSync(
      jsonOut,
      JSON.stringify({ runtimeSha: ok[0]?.runtimeSha, engineGate, series, verdicts }, null, 2),
    )
  const gated = armFailures.length > 0 || (engineGate && engineFailures.length > 0)
  return gated || uncaught.length > 0 ? 1 : 0
}

/**
 * A plant is caught when it fails a check its kind must fail: `hold:<n>`
 * (memory that grows with history) a history check; `double:<ms>` (time that
 * doubles on a grown cell) any time check; any other plant any history check.
 */
export function plantCaught(verdicts: readonly GrowthVerdict[], plant: string): boolean {
  const kind = plant.split('+')[1]?.split(':')[0]
  return verdicts.some(
    (v) =>
      v.label === plant &&
      !v.pass &&
      (kind === 'double' ? v.kind === 'time' : v.check === 'history flat'),
  )
}

if (import.meta.main) process.exitCode = runGrowth(process.argv.slice(2), console.log)
