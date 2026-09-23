/**
 * POD-4562 (L5f) — complete-or-fail. A timing run either has every cell it
 * planned, at the planned sample count, with every record under the load
 * ceiling, or it produces no results file: there is no withheld cell and no
 * provisional number. The driver (`run.ts`), the matrix (`matrix.ts`) and the
 * summary (`summarize.ts`) all judge completeness here, the same way.
 *
 * Importing this never starts a browser.
 */
import { type RunOutput, SCENARIOS, type Scale, type ScenarioName } from './records'

/** The 1-minute load ceiling (methodology §5.7). `--max-load` may lower it, never raise it. */
export const MAX_LOAD = 8

/** Every summary covers all three corpus scales: the slope and the 4x click need them. */
export const SCALES: readonly Scale[] = [1, 2, 4]

/** The matrix writes its plan here, beside the runs; `summarize.ts` checks the runs against it. */
export const MATRIX_PLAN_FILE = 'matrix-plan.json'

/** A failed run's diagnostic file: never at the results path, never summarised as a result. */
export function failedPathFor(out: string): string {
  return out.replace(/(\.json)?$/, '.failed.json')
}

export function checkMaxLoad(maxLoad: number): number {
  if (!Number.isFinite(maxLoad) || maxLoad <= 0 || maxLoad > MAX_LOAD) {
    throw new Error(`--max-load must be in (0, ${MAX_LOAD}] (got ${maxLoad})`)
  }
  return maxLoad
}

export interface RunPlan {
  arm: string
  plant: string | null
  scale: Scale
  scenarios: ScenarioName[]
  samples: number
  warmup: number
  maxLoad: number
}

export interface PlannedRound {
  /** Warm-up rounds number -warmup..-1; measured samples 0..samples-1. */
  sample: number
  warmup: boolean
  order: ScenarioName[]
}

/** The rounds `run.ts` executes, in order: the scenario order rotates per round so drift hits every scenario. */
export function plannedRounds(
  plan: Pick<RunPlan, 'scenarios' | 'samples' | 'warmup'>,
): PlannedRound[] {
  const rounds = plan.warmup + plan.samples
  return Array.from({ length: rounds }, (_, round) => ({
    sample: round - plan.warmup,
    warmup: round < plan.warmup,
    order: plan.scenarios.map(
      (_, i) => plan.scenarios[(i + round) % plan.scenarios.length] as ScenarioName,
    ),
  }))
}

/** `run.ts --dry-run`: the plan, one line per round, and what a complete run must hold. */
export function describePlan(plan: RunPlan, out: string): string[] {
  const label = plan.plant ? `${plan.arm}+${plan.plant}` : plan.arm
  return [
    `[browser] dry run: ${label} ${plan.scale}x, ${plan.warmup} warm-up + ${plan.samples} measured rounds, load ceiling ${plan.maxLoad}`,
    ...plannedRounds(plan).map(
      (r) => `  ${r.warmup ? `warm-up ${r.sample}` : `sample ${r.sample}`}: ${r.order.join(', ')}`,
    ),
    `  complete = ${plan.scenarios.length} cells x ${plan.samples} measured records (+ ${plan.warmup} warm-up each), every record at load <= ${plan.maxLoad}`,
    `  results file: ${out} (only when complete); otherwise ${failedPathFor(out)} and exit 2`,
  ]
}

/**
 * Why a driver run is not complete: each scenario must hold exactly the
 * planned warm-up and measured records, and no record may exceed the load
 * ceiling. Empty when the run may be written as a result.
 */
export function runShortfalls(
  output: Pick<RunOutput, 'scenarios' | 'samples' | 'warmup' | 'maxLoad' | 'records'>,
): string[] {
  const out: string[] = []
  if (!(output.samples >= 1)) out.push(`samples ${output.samples}: a run needs at least one`)
  const ceiling = Math.min(output.maxLoad, MAX_LOAD)
  for (const scenario of output.scenarios) {
    const mine = output.records.filter((r) => r.scenario === scenario)
    const measured = mine.filter((r) => !r.warmup).length
    const warm = mine.length - measured
    if (measured !== output.samples) {
      out.push(`cell ${scenario}: ${measured} of ${output.samples} measured records`)
    }
    if (warm !== output.warmup)
      out.push(`cell ${scenario}: ${warm} of ${output.warmup} warm-up records`)
  }
  for (const record of output.records) {
    if (!output.scenarios.includes(record.scenario)) {
      out.push(`record ${record.scenario}#${record.sample} is outside the plan`)
    }
    if (!(record.loadavg <= ceiling)) {
      out.push(
        `load ${record.loadavg.toFixed(2)} > ${ceiling} at ${record.scenario}#${record.sample}`,
      )
    }
  }
  return out
}

/** What `matrix.ts` promised: every (arm, scale) pair once per round. */
export interface MatrixPlan {
  arms: string[]
  scales: Scale[]
  rounds: number
  samples: number
  warmup: number
  scenarios: ScenarioName[]
  maxLoad: number
}

export function matrixRunFile(round: number, arm: string, scale: Scale): string {
  return `r${round}-${arm}-${scale}x.json`
}

const labelOf = (r: { arm: string; plant: string | null }): string =>
  r.plant ? `${r.arm}+${r.plant}` : r.arm

/**
 * Why a set of ok runs cannot be summarised. The grid is every arm present
 * plus the no-op floor (every budget is floor + allowance) × 1x/2x/4x × every
 * scenario any run declared; each cell must hold the same number of measured
 * records, at least `minSamples`, and — with a matrix plan — exactly
 * rounds × samples, from every planned file. Any record over the load ceiling
 * refuses the set. Empty when complete.
 */
export function gridShortfalls(
  runs: RunOutput[],
  options: {
    minSamples: number
    plan?: MatrixPlan
    /** File names of the ok runs, parallel to `runs`; required with `plan`. */
    files?: string[]
  },
): string[] {
  const out: string[] = []
  const { plan } = options
  if (runs.length === 0) return ['no ok runs']
  const arms = new Set([...(plan?.arms ?? []), ...runs.map(labelOf), 'noop'])
  const scenarios = new Set<ScenarioName>(plan?.scenarios ?? runs.flatMap((r) => r.scenarios))
  const scales = plan?.scales ?? SCALES
  for (const scale of SCALES) {
    if (!scales.includes(scale)) out.push(`plan omits ${scale}x`)
  }
  const n = new Map<string, number>()
  for (const run of runs) {
    if (run.maxLoad > MAX_LOAD)
      out.push(`run ${labelOf(run)} ${run.scale}x allowed load ${run.maxLoad} > ${MAX_LOAD}`)
    for (const record of run.records) {
      if (!(record.loadavg <= MAX_LOAD)) {
        out.push(
          `load ${record.loadavg.toFixed(2)} > ${MAX_LOAD} at ${labelOf(record)} ${record.scale}x ${record.scenario}#${record.sample}`,
        )
      }
      if (record.warmup) continue
      const key = `${labelOf(record)}|${record.scenario}|${record.scale}`
      n.set(key, (n.get(key) ?? 0) + 1)
    }
  }
  const required = plan ? plan.rounds * plan.samples : Math.max(options.minSamples, ...n.values())
  if (plan && required < options.minSamples) {
    out.push(`plan gives ${required} samples per cell, fewer than ${options.minSamples}`)
  }
  for (const arm of [...arms].sort()) {
    for (const scenario of SCENARIOS.filter((s) => scenarios.has(s))) {
      for (const scale of SCALES) {
        const have = n.get(`${arm}|${scenario}|${scale}`) ?? 0
        if (have !== required)
          out.push(`cell ${arm} ${scenario} ${scale}x: ${have} of ${required} samples`)
      }
    }
  }
  if (plan) {
    const files = new Set(options.files ?? [])
    for (let round = 0; round < plan.rounds; round += 1) {
      for (const arm of plan.arms) {
        for (const scale of plan.scales) {
          const file = matrixRunFile(round, arm, scale)
          if (!files.has(file)) out.push(`run ${file}: no ok output`)
        }
      }
    }
  }
  return out
}

/**
 * A run that failed only because the box was loaded (load before or during
 * it, and the cells it therefore never reached): `matrix.ts` retries it after
 * the load drops. Any other failure fails the matrix.
 */
export function isLoadOnlyFailure(failures: readonly string[]): boolean {
  return (
    failures.some((f) => f.startsWith('load ')) &&
    failures.every((f) => f.startsWith('load ') || f.startsWith('cell '))
  )
}
