// POD-4562 (L5f): a timing run is complete or it fails; nothing is withheld.
import { describe, expect, it } from 'vitest'
import {
  checkMaxLoad,
  describePlan,
  failedPathFor,
  gridShortfalls,
  isLoadOnlyFailure,
  type MatrixPlan,
  matrixRunFile,
  plannedRounds,
  runShortfalls,
} from './complete'
import { type RunOutput, SCENARIOS, type Scale, type TimingRecord } from './records'
import { completeRun, record } from './test-fixtures'

const SCALES: Scale[] = [1, 2, 4]

describe('runShortfalls (the driver writes a results file only when it is empty)', () => {
  it('passes a run with every planned record under the ceiling', () => {
    expect(runShortfalls(completeRun('mobx-write', 1, { samples: 5 }))).toEqual([])
  })

  it('names a cell short of its measured records', () => {
    const run = completeRun('mobx-write', 1, { samples: 5 })
    run.records = run.records.filter((r) => !(r.scenario === 'click' && r.sample === 4))
    expect(runShortfalls(run)).toEqual(['cell click: 4 of 5 measured records'])
  })

  it('names every cell of a run that never started', () => {
    const run = { ...completeRun('mobx-write', 1, { samples: 5 }), records: [] }
    expect(runShortfalls(run)).toHaveLength(SCENARIOS.length * 2)
    expect(runShortfalls(run)[0]).toBe('cell heartbeat: 0 of 5 measured records')
  })

  it('names a missing warm-up record', () => {
    const run = completeRun('mobx-write', 1, { samples: 5 })
    run.records = run.records.filter((r) => !(r.scenario === 'rename' && r.warmup))
    expect(runShortfalls(run)).toEqual(['cell rename: 0 of 1 warm-up records'])
  })

  it('fails any record above the load ceiling, 8 even when the run allowed more', () => {
    const run = completeRun('mobx-write', 1, { samples: 5 })
    ;(run.records[3] as TimingRecord).loadavg = 8.01
    expect(runShortfalls(run)).toEqual([
      `load 8.01 > 8 at ${run.records[3]?.scenario}#${run.records[3]?.sample}`,
    ])
    expect(runShortfalls({ ...run, maxLoad: 12 })).toHaveLength(1)
    // A lowered ceiling holds too.
    ;(run.records[3] as TimingRecord).loadavg = 6.5
    expect(runShortfalls({ ...run, maxLoad: 6 })).toHaveLength(1)
  })

  it('refuses a record outside the plan', () => {
    const run = completeRun('mobx-write', 1, { samples: 1, warmup: 0, scenarios: ['rename'] })
    run.records.push(record({ arm: 'mobx-write', scenario: 'click' }))
    expect(runShortfalls(run)).toEqual(['record click#0 is outside the plan'])
  })

  it('refuses zero samples', () => {
    const run = completeRun('mobx-write', 1, { samples: 0, warmup: 0 })
    expect(runShortfalls(run)).toEqual(['samples 0: a run needs at least one'])
  })
})

describe('driver plan', () => {
  it('rotates the scenario order per round, warm-up first', () => {
    const rounds = plannedRounds({ scenarios: ['rename', 'click', 'clock'], samples: 2, warmup: 1 })
    expect(rounds).toEqual([
      { sample: -1, warmup: true, order: ['rename', 'click', 'clock'] },
      { sample: 0, warmup: false, order: ['click', 'clock', 'rename'] },
      { sample: 1, warmup: false, order: ['clock', 'rename', 'click'] },
    ])
  })

  it('--dry-run lists every round and what complete means', () => {
    const lines = describePlan(
      {
        arm: 'noop',
        plant: 'walk:2',
        scale: 4,
        scenarios: ['rename', 'click'],
        samples: 2,
        warmup: 1,
        maxLoad: 8,
      },
      'out/r0.json',
    )
    expect(lines).toEqual([
      '[browser] dry run: noop+walk:2 4x, 1 warm-up + 2 measured rounds, load ceiling 8',
      '  warm-up -1: rename, click',
      '  sample 0: click, rename',
      '  sample 1: rename, click',
      '  complete = 2 cells x 2 measured records (+ 1 warm-up each), every record at load <= 8',
      '  results file: out/r0.json (only when complete); otherwise out/r0.failed.json and exit 2',
    ])
  })

  it('never raises the load ceiling', () => {
    expect(checkMaxLoad(8)).toBe(8)
    expect(checkMaxLoad(6)).toBe(6)
    expect(() => checkMaxLoad(9)).toThrow('--max-load must be in (0, 8]')
    expect(() => checkMaxLoad(Number.NaN)).toThrow()
  })

  it('keeps a failed run off the results path', () => {
    expect(failedPathFor('results/floor/r0-noop-1x.json')).toBe(
      'results/floor/r0-noop-1x.failed.json',
    )
  })

  it('retries a run only when the box load is all that failed it', () => {
    expect(
      isLoadOnlyFailure([
        'load 9.10 > 8 before the run; nothing timed',
        'cell rename: 0 of 5 measured records',
      ]),
    ).toBe(true)
    expect(isLoadOnlyFailure(['load 8.20 > 8 at rename#3'])).toBe(true)
    expect(isLoadOnlyFailure(['cell rename: 4 of 5 measured records'])).toBe(false)
    expect(
      isLoadOnlyFailure(['load 8.20 > 8 at rename#3', 'rename#3: parity — arm a vs oracle b']),
    ).toBe(false)
  })
})

describe('gridShortfalls (the summary refuses an incomplete set)', () => {
  const grid = (arms: TimingRecord['arm'][], samples = 20): RunOutput[] =>
    arms.flatMap((arm) => SCALES.map((scale) => completeRun(arm, scale, { samples })))

  it('passes arms and the floor at every scale and scenario', () => {
    expect(gridShortfalls(grid(['noop', 'mobx-write']), { minSamples: 20 })).toEqual([])
  })

  it('refuses a missing scale', () => {
    const runs = grid(['noop', 'mobx-write']).filter((r) => !(r.arm === 'mobx-write' && r.scale === 4))
    const out = gridShortfalls(runs, { minSamples: 20 })
    expect(out).toHaveLength(SCENARIOS.length)
    expect(out[0]).toBe('cell mobx-write heartbeat 4x: 0 of 20 samples')
  })

  it('refuses an arm without the no-op floor its budgets need', () => {
    const out = gridShortfalls(grid(['mobx-write']), { minSamples: 20 })
    expect(out).toHaveLength(SCENARIOS.length * 3)
    expect(out.every((s) => s.startsWith('cell noop '))).toBe(true)
  })

  it('refuses cells of unequal size, and cells below the p95 minimum', () => {
    const runs = grid(['noop', 'mobx-write'])
    runs.push(completeRun('mobx-write', 2, { samples: 5 }))
    const out = gridShortfalls(runs, { minSamples: 20 })
    expect(out).toContain('cell noop rename 1x: 20 of 25 samples')
    expect(gridShortfalls(grid(['noop', 'mobx-write'], 10), { minSamples: 20 })).toContain(
      'cell mobx-write click 1x: 10 of 20 samples',
    )
  })

  it('refuses a record above load 8 even in an ok run', () => {
    const runs = grid(['noop', 'mobx-write'])
    ;(runs[2]?.records[7] as TimingRecord).loadavg = 9.4
    expect(gridShortfalls(runs, { minSamples: 20 })).toHaveLength(1)
    expect(gridShortfalls(runs, { minSamples: 20 })[0]).toMatch(/^load 9\.40 > 8 at noop 4x /)
  })

  it('holds a matrix to its plan: every planned file, rounds x samples per cell', () => {
    const plan: MatrixPlan = {
      arms: ['noop', 'mobx-write'],
      scales: SCALES,
      rounds: 4,
      samples: 5,
      warmup: 1,
      scenarios: [...SCENARIOS],
      maxLoad: 8,
    }
    const runs: RunOutput[] = []
    const files: string[] = []
    for (let round = 0; round < 4; round += 1) {
      for (const arm of ['noop', 'mobx-write'] as const) {
        for (const scale of SCALES) {
          runs.push(completeRun(arm, scale, { samples: 5 }))
          files.push(matrixRunFile(round, arm, scale))
        }
      }
    }
    expect(gridShortfalls(runs, { minSamples: 20, plan, files })).toEqual([])
    // Round 3's hand 2x never passed: its cells are 15 of 20 and its file is missing.
    const drop = files.indexOf('r3-mobx-write-2x.json')
    const out = gridShortfalls(
      runs.filter((_, i) => i !== drop),
      { minSamples: 20, plan, files: files.filter((_, i) => i !== drop) },
    )
    expect(out).toContain('cell mobx-write rename 2x: 15 of 20 samples')
    expect(out).toContain('run r3-mobx-write-2x.json: no ok output')
    // A plan too small for a p95 refuses before any run.
    expect(gridShortfalls(runs, { minSamples: 20, plan: { ...plan, rounds: 2 }, files })).toContain(
      'plan gives 10 samples per cell, fewer than 20',
    )
  })
})
