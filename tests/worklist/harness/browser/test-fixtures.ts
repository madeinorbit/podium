// POD-4562 (L5f): driver-output fixtures for the browser harness's unit tests.
import { plannedRounds } from './complete'
import {
  type RunOutput,
  SCENARIOS,
  type Scale,
  type ScenarioName,
  type TimingRecord,
} from './records'

export function record(overrides: Partial<TimingRecord>): TimingRecord {
  return {
    arm: 'noop',
    plant: null,
    scale: 1,
    scenario: 'rename',
    sample: 0,
    warmup: false,
    target: null,
    actionMs: 1,
    drainMs: 1,
    frameMs: 2,
    endedBy: 'drain',
    commits: 0,
    mounts: 0,
    domMutations: 0,
    strayCommits: 0,
    longTasks: 0,
    longTaskMs: 0,
    heapBefore: null,
    heapAfter: null,
    mountedRows: 50,
    stats: { rowsDerived: 0, rollupsDerived: 0, indexUpdates: 0, notifications: 0 },
    loadavg: 2,
    uptime: 1,
    runtimeSha: 'abc',
    ...overrides,
  }
}

/** One complete driver run: every scenario, `warmup` + `samples` records each. */
export function completeRun(
  arm: TimingRecord['arm'],
  scale: Scale,
  options: { samples?: number; warmup?: number; scenarios?: ScenarioName[]; plant?: string } = {},
): RunOutput {
  const samples = options.samples ?? 20
  const warmup = options.warmup ?? 1
  const scenarios = options.scenarios ?? [...SCENARIOS]
  const plant = options.plant ?? null
  const records = plannedRounds({ scenarios, samples, warmup }).flatMap((round) =>
    round.order.map((scenario) =>
      record({
        arm,
        plant,
        scale,
        scenario,
        sample: round.sample,
        warmup: round.warmup,
        target: `${scale}-${scenario}-${round.sample}`,
        actionMs: arm === 'noop' ? 1 : 2,
      }),
    ),
  )
  return {
    status: 'ok',
    failures: [],
    runtimeSha: 'abc',
    host: 'flatblock',
    browser: 'chromium',
    capturedAt: '2026-09-23T00:00:00.000Z',
    arm,
    plant,
    scale,
    quietMs: 250,
    maxLoad: 8,
    corpus: null,
    scenarios,
    samples,
    warmup,
    records,
  }
}
