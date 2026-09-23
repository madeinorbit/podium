/**
 * POD-4558 (L5b) — summarise driver output: per (arm, scenario, scale) the
 * actionMs distribution, the no-op floor, the budget as floor + allowance, and
 * the wall slope across 1x/2x/4x.
 *
 * Refuses any failed run (load over the limit, an errored cell): its numbers
 * are listed as failed and never enter a table. Warm-up records are dropped.
 *
 * Budgets (methodology §1a, restated on the floor before any round-three arm
 * is measured — `docs/plans/pod-4441-harness.md`, "Instrument floor"). Every
 * wall budget is on the arm's time ABOVE the no-op page's (coordinator ruling
 * on POD-4558 finding (a): the no-op alone failed the raw slope and the 2 ms
 * publish, so those budgets failed every arm before it did anything):
 * - unrelated heartbeat (publish): actionMs p95 at 1x <= noop p95 + 2 ms;
 * - other hot-path events (rename, stagemove, clock, and visibleHeartbeat — a
 *   one-row redraw like the rename, set before any measurement, POD-4560):
 *   p95 at 1x <= noop p95 + 8 ms;
 * - click: actionMs p95 <= noop p95 + 16 ms at 1x, + 32 ms at 4x;
 * - slope: (arm p50 - noop p50) at 4x over the same at 1x <= 1.2, the 1x
 *   excess taken as at least `SLOPE_MIN_EXCESS_MS`. The raw p50 ratio is
 *   printed beside it, not budgeted.
 *
 * A low read count (the reads fence) is not proof of constant work: the fence
 * counts entity rows, not an arm's walks over its own per-row caches. The
 * slope is where that work shows.
 *
 *   bun packages/worklist-proto/harness/browser/summarize.ts <result dir or files...> [--json out.json]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Distribution,
  distribution,
  type RunOutput,
  type Scale,
  type ScenarioName,
  type TimingRecord,
} from './records'

export const HOT_PATH_ALLOWANCE_MS = 8
/** #1's publish budget, restated from "publish <= 2 ms" to 2 ms above the no-op. */
export const HEARTBEAT_ALLOWANCE_MS = 2
export const CLICK_ALLOWANCE_MS: Partial<Record<Scale, number>> = { 1: 16, 4: 32 }
export const SLOPE_BUDGET = 1.2
/**
 * The smallest 1x excess over the floor the slope divides by. The no-op's
 * per-round p50 moves by at most 0.3 ms on the sub-millisecond scenarios
 * (clock, click, rename at 1x), so an excess below 1 ms is timer noise, and a
 * ratio over it would turn a 0.2 ms wobble into a verdict.
 */
export const SLOPE_MIN_EXCESS_MS = 1

/**
 * The restated slope: the arm's excess over the no-op at 4x divided by its
 * excess at 1x (at least `SLOPE_MIN_EXCESS_MS`). Null when a cell is missing.
 */
export function excessSlope(
  arm1x: number | null,
  arm4x: number | null,
  floor1x: number | null,
  floor4x: number | null,
): number | null {
  if (arm1x === null || arm4x === null || floor1x === null || floor4x === null) return null
  return (arm4x - floor4x) / Math.max(arm1x - floor1x, SLOPE_MIN_EXCESS_MS)
}

export interface Cell {
  /** The arm, or `noop+<plant>` for a timer self-test run. */
  arm: string
  scenario: ScenarioName
  scale: Scale
  actionMs: Distribution
  drainMs: Distribution
  frameMs: Distribution
  commitsMedian: number | null
  longTasks: number
  strayCommits: number
  maxLoad: number
  runs: number
}

function median(values: number[]): number | null {
  return distribution(values).p50
}

export function loadRuns(paths: string[]): {
  ok: RunOutput[]
  failed: { path: string; run: RunOutput }[]
} {
  const files = paths.flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => f.endsWith('.json'))
          .map((f) => join(p, f))
      : [p],
  )
  const ok: RunOutput[] = []
  const failed: { path: string; run: RunOutput }[] = []
  for (const path of files) {
    const run = JSON.parse(readFileSync(path, 'utf-8')) as RunOutput
    if (run.status === 'ok') ok.push(run)
    else failed.push({ path, run })
  }
  return { ok, failed }
}

export function cells(runs: RunOutput[]): Cell[] {
  const groups = new Map<string, { records: TimingRecord[]; runs: Set<RunOutput> }>()
  for (const run of runs) {
    for (const record of run.records) {
      if (record.warmup) continue
      const label = record.plant ? `${record.arm}+${record.plant}` : record.arm
      const key = `${label}|${record.scenario}|${record.scale}`
      const group = groups.get(key) ?? { records: [], runs: new Set() }
      group.records.push(record)
      group.runs.add(run)
      groups.set(key, group)
    }
  }
  return [...groups.values()].map(({ records, runs: from }) => {
    const first = records[0] as TimingRecord
    return {
      arm: first.plant ? `${first.arm}+${first.plant}` : first.arm,
      scenario: first.scenario,
      scale: first.scale,
      actionMs: distribution(records.map((r) => r.actionMs)),
      drainMs: distribution(records.map((r) => r.drainMs)),
      frameMs: distribution(records.map((r) => r.frameMs)),
      commitsMedian: median(records.map((r) => r.commits)),
      longTasks: records.reduce((sum, r) => sum + r.longTasks, 0),
      strayCommits: records.reduce((sum, r) => sum + r.strayCommits, 0),
      maxLoad: Math.max(...records.map((r) => r.loadavg)),
      runs: from.size,
    }
  })
}

/**
 * Every arm must aim each change at the same target (POD-4558: targets are
 * picked by rule from the oracle's first window, never from an arm's draw
 * order). Per (scale, scenario, sample, warm-up) the target must be one value
 * across every arm and every round; each disagreement is returned, and the
 * summary refuses to compare arms that timed different rows.
 */
export function targetMismatches(runs: RunOutput[]): string[] {
  const seen = new Map<string, Map<string | null, string[]>>()
  for (const run of runs) {
    for (const record of run.records) {
      const key = `${record.scale}x ${record.scenario}#${record.sample}${record.warmup ? ' (warm-up)' : ''}`
      const byTarget = seen.get(key) ?? new Map<string | null, string[]>()
      const arms = byTarget.get(record.target) ?? []
      arms.push(record.plant ? `${record.arm}+${record.plant}` : record.arm)
      byTarget.set(record.target, arms)
      seen.set(key, byTarget)
    }
  }
  const out: string[] = []
  for (const [key, byTarget] of seen) {
    if (byTarget.size <= 1) continue
    const parts = [...byTarget].map(
      ([target, arms]) => `${target} (${[...new Set(arms)].join(',')})`,
    )
    out.push(`${key}: ${parts.join(' vs ')}`)
  }
  return out
}

export function allowanceMs(scenario: ScenarioName, scale: Scale): number | null {
  if (scenario === 'click') return CLICK_ALLOWANCE_MS[scale] ?? null
  if (scale !== 1) return null
  return scenario === 'heartbeat' ? HEARTBEAT_ALLOWANCE_MS : HOT_PATH_ALLOWANCE_MS
}

const f = (v: number | null, digits = 2): string => (v === null ? '—' : v.toFixed(digits))

/**
 * The summary's entry point: prints the tables through `print` and returns the
 * exit code. 2 (and no table) when the runs come from more than one machine or
 * their arms aimed a change at different targets; 0 otherwise. Failed runs are listed and never summarised.
 */
export function runSummary(argv: string[], print: (line: string) => void): number {
  const jsonIndex = argv.indexOf('--json')
  const jsonOut = jsonIndex >= 0 ? argv[jsonIndex + 1] : undefined
  const paths = argv.filter((_, i) => jsonIndex < 0 || (i !== jsonIndex && i !== jsonIndex + 1))
  const { ok, failed } = loadRuns(paths)
  for (const { path, run } of failed) {
    print(`FAILED RUN (not summarised): ${path} — ${run.failures.join('; ')}`)
  }
  // Anything compared must be timed on the same machine (POD-4286 ruling).
  const hosts = [...new Set(ok.map((r) => r.host ?? 'unrecorded'))]
  if (hosts.length > 1) {
    print(`MACHINES DIFFER (not summarised): ${hosts.join(', ')}`)
    return 2
  }
  const mismatches = targetMismatches(ok)
  if (mismatches.length > 0) {
    for (const m of mismatches) print(`TARGETS DIFFER (not summarised): ${m}`)
    return 2
  }
  const table = cells(ok).sort(
    (a, b) =>
      a.arm.localeCompare(b.arm) || a.scenario.localeCompare(b.scenario) || a.scale - b.scale,
  )
  const floor = (scenario: ScenarioName, scale: Scale): Cell | undefined =>
    table.find((c) => c.arm === 'noop' && c.scenario === scenario && c.scale === scale)
  const shas = [...new Set(ok.map((r) => r.runtimeSha))]
  print(
    `host ${hosts.join(', ')}; runtimeSha ${shas.join(', ')}; ${ok.length} ok runs, ${failed.length} failed`,
  )
  print('')
  print(
    '| Arm | Scenario | Scale | n | actionMs p50 / p95 / max | drainMs p50 | frameMs p50 | commits (median) | long tasks | stray | floor p95 | budget p95 | verdict | max load |',
  )
  print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const c of table) {
    const fl = floor(c.scenario, c.scale)
    const allowance = allowanceMs(c.scenario, c.scale)
    const budget =
      fl?.actionMs.p95 != null && allowance !== null ? fl.actionMs.p95 + allowance : null
    const verdict =
      c.arm === 'noop' || budget === null
        ? '—'
        : c.actionMs.p95 === null
          ? 'n < 20'
          : c.actionMs.p95 <= budget
            ? 'within'
            : 'OVER'
    print(
      `| ${c.arm} | ${c.scenario} | ${c.scale}x | ${c.actionMs.n} | ` +
        `${f(c.actionMs.p50)} / ${f(c.actionMs.p95)} / ${f(c.actionMs.max)} | ${f(c.drainMs.p50)} | ` +
        `${f(c.frameMs.p50, 1)} | ${f(c.commitsMedian, 0)} | ${c.longTasks} | ${c.strayCommits} | ` +
        `${f(fl?.actionMs.p95 ?? null)} | ${f(budget)} | ${verdict} | ${c.maxLoad.toFixed(2)} |`,
    )
  }
  print('')
  print(
    '| Arm | Scenario | p50 1x / 2x / 4x | raw p50 4x/1x | excess over floor 4x/1x (budget ≤ 1.2) |',
  )
  print('|---|---|---|---|---|')
  const slopes: {
    arm: string
    scenario: ScenarioName
    slope: number | null
    excessSlope: number | null
  }[] = []
  const armScenarios = [...new Set(table.map((c) => `${c.arm}|${c.scenario}`))]
  for (const key of armScenarios) {
    const [arm, scenario] = key.split('|') as [string, ScenarioName]
    const at = (scale: Scale): number | null =>
      table.find((c) => c.arm === arm && c.scenario === scenario && c.scale === scale)?.actionMs
        .p50 ?? null
    const floorAt = (scale: Scale): number | null => floor(scenario, scale)?.actionMs.p50 ?? null
    const p1 = at(1)
    const p4 = at(4)
    const slope = p1 !== null && p4 !== null && p1 > 0 ? p4 / p1 : null
    const f1 = floorAt(1)
    const f4 = floorAt(4)
    const excess = arm === 'noop' ? null : excessSlope(p1, p4, f1, f4)
    slopes.push({ arm, scenario, slope, excessSlope: excess })
    const verdict = excess === null ? '' : excess <= SLOPE_BUDGET ? ' within' : ' OVER'
    print(
      `| ${arm} | ${scenario} | ${f(p1)} / ${f(at(2))} / ${f(p4)} | ${f(slope)} | ${f(excess)}${verdict} |`,
    )
  }
  if (jsonOut !== undefined) {
    writeFileSync(
      jsonOut,
      JSON.stringify(
        { runtimeSha: shas, cells: table, slopes, failed: failed.map((x) => x.path) },
        null,
        2,
      ),
    )
  }
  return 0
}

if (import.meta.main) process.exitCode = runSummary(process.argv.slice(2), console.log)
