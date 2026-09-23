/**
 * POD-4558 (L5b) — the browser driver's record shapes and the statistics
 * every consumer computes the same way (`run.ts` writes, `summarize.ts`
 * reads). Importing this never starts a browser.
 */
import type { ProtoScenarioResult } from '../web/entrylib'

export const ARMS = ['control', 'hand', 'mobx', 'noop'] as const
export type ArmName = (typeof ARMS)[number]
export type Scale = 1 | 2 | 4
export const SCENARIOS = ['heartbeat', 'rename', 'stagemove', 'clock', 'click'] as const
export type ScenarioName = (typeof SCENARIOS)[number]

export interface HeapUsage {
  usedSize: number
  totalSize: number
  embedderHeapUsedSize?: number
  backingStorageSize?: number
}

export interface TimingRecord {
  arm: ArmName
  /** A timer self-test plant (`--plant`), summarised under its own label. */
  plant: string | null
  scale: Scale
  scenario: ScenarioName
  sample: number
  /** Warm-up rounds are recorded, never summarised. */
  warmup: boolean
  target: string | null
  /** Change dispatch to the arm's last commit signal (or the drain), ms. */
  actionMs: number
  /** Change dispatch to the first task after it (microtasks drained), ms. */
  drainMs: number
  /** Change dispatch to the next animation frame after `actionMs`, ms. Not budgeted. */
  frameMs: number
  endedBy: ProtoScenarioResult['endedBy']
  commits: number
  mounts: number
  domMutations: number
  strayCommits: number
  longTasks: number
  longTaskMs: number
  heapBefore: HeapUsage | null
  heapAfter: HeapUsage | null
  mountedRows: number
  /** Check mode (`--check`): the arm's redraw against the oracle over rows drawn before and after. */
  oracle?: { changed: number; drawn: number; over: string[]; under: string[] } | null
  /** POD-4559: the arm's slice-output hash against the oracle's for the same
   *  engine state, taken after the sample (untimed); `firstDifference` names
   *  the first differing row, null when the hashes agree. */
  parity?: { arm: string; oracle: string; firstDifference: string | null }
  stats: ProtoScenarioResult['stats']
  loadavg: number
  uptime: number
  runtimeSha: string
}

export interface RunOutput {
  status: 'ok' | 'failed'
  failures: string[]
  runtimeSha: string
  /** The machine that timed the run: only runs from one machine are compared. */
  host?: string
  browser: string | null
  capturedAt: string
  arm: ArmName
  plant: string | null
  scale: Scale
  /** The page settle's quiet window, ms. */
  quietMs: number | null
  maxLoad: number
  corpus: unknown
  scenarios: ScenarioName[]
  samples: number
  warmup: number
  records: TimingRecord[]
}

/** Nearest-rank percentile of ascending `sorted`; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p * sorted.length) / 100)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null
}

/**
 * Fewest samples for which a nearest-rank p95 is not simply the maximum
 * (rank ceil(0.95 n) < n needs n >= 20). Below it the summary reports p95 as
 * null and says so: a max is never presented as a p95.
 */
export const MIN_SAMPLES_FOR_P95 = 20

export interface Distribution {
  n: number
  p50: number | null
  p95: number | null
  max: number | null
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: sorted.length >= MIN_SAMPLES_FOR_P95 ? percentile(sorted, 95) : null,
    max: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
  }
}
