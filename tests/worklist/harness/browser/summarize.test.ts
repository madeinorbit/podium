// POD-4558 (L5b): the driver summary's statistics and refusals.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MATRIX_PLAN_FILE, type MatrixPlan, matrixRunFile } from './complete'
import {
  distribution,
  MIN_SAMPLES_FOR_P95,
  type RunOutput,
  SCENARIOS as SCENARIOS_ALL,
  type Scale,
  type TimingRecord,
} from './records'
import {
  allowanceMs,
  cells,
  excessSlope,
  loadRuns,
  runSummary,
  SLOPE_BUDGET,
  SLOPE_MIN_EXCESS_MS,
  targetMismatches,
} from './summarize'
import { completeRun, record } from './test-fixtures'

function run(records: TimingRecord[], status: RunOutput['status'] = 'ok'): RunOutput {
  return {
    status,
    failures: status === 'ok' ? [] : ['load 11.00 > 8 at rename#0'],
    runtimeSha: 'abc',
    browser: 'chromium',
    capturedAt: '2026-09-23T00:00:00.000Z',
    arm: records[0]?.arm ?? 'noop',
    plant: records[0]?.plant ?? null,
    scale: records[0]?.scale ?? 1,
    quietMs: 250,
    maxLoad: 8,
    corpus: null,
    scenarios: ['rename'],
    samples: records.length,
    warmup: 0,
    records,
  }
}

describe('distribution', () => {
  it('never presents a max as a p95', () => {
    const nineteen = distribution(Array.from({ length: 19 }, (_, i) => i + 1))
    expect(nineteen.p95).toBeNull()
    expect(nineteen.max).toBe(19)
    const twenty = distribution(Array.from({ length: MIN_SAMPLES_FOR_P95 }, (_, i) => i + 1))
    expect(twenty.p95).toBe(19)
    expect(twenty.max).toBe(20)
    expect(twenty.p50).toBe(10)
  })
})

describe('cells', () => {
  it('drops warm-up records and keeps a planted run under its own label', () => {
    const table = cells([
      run([
        record({ actionMs: 500, warmup: true }),
        record({ actionMs: 1 }),
        record({ actionMs: 3 }),
      ]),
      run([record({ plant: 'late:30', actionMs: 33 })]),
    ])
    const floor = table.find((c) => c.arm === 'noop')
    const planted = table.find((c) => c.arm === 'noop+late:30')
    expect(floor?.actionMs).toMatchObject({ n: 2, max: 3 })
    expect(planted?.actionMs).toMatchObject({ n: 1, max: 33 })
  })

  it('pools records of one cell across interleaved runs', () => {
    const table = cells([run([record({ actionMs: 1 })]), run([record({ actionMs: 2 })])])
    expect(table).toHaveLength(1)
    expect(table[0]).toMatchObject({ runs: 2, actionMs: { n: 2 } })
  })
})

describe('loadRuns', () => {
  it('refuses a failed run: its numbers never reach a cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-4558-'))
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(run([record({ actionMs: 1 })])))
    writeFileSync(
      join(dir, 'failed.json'),
      JSON.stringify(run([record({ actionMs: 999 })], 'failed')),
    )
    const { ok, failed } = loadRuns([dir])
    expect(ok).toHaveLength(1)
    expect(failed.map((f) => f.path)).toEqual([join(dir, 'failed.json')])
    expect(cells(ok)[0]?.actionMs.max).toBe(1)
  })
})

describe('allowanceMs', () => {
  it('budgets the hot path at live corpus and the click at 1x and 4x', () => {
    expect(allowanceMs('rename', 1)).toBe(8)
    // #1's publish budget: 2 ms above the no-op (was "publish <= 2 ms" absolute).
    expect(allowanceMs('heartbeat', 1)).toBe(2)
    expect(allowanceMs('rename', 4)).toBeNull()
    expect(allowanceMs('click', 1)).toBe(16)
    expect(allowanceMs('click', 4)).toBe(32)
    expect(allowanceMs('click', 2)).toBeNull()
  })

  it('is the harness doc table, every scenario at 1x, 2x and 4x (POD-4562)', () => {
    const table = Object.fromEntries(
      SCENARIOS_ALL.map((scenario) => [
        scenario,
        ([1, 2, 4] as const).map((scale) => allowanceMs(scenario, scale)),
      ]),
    )
    expect(table).toEqual({
      heartbeat: [2, null, null],
      visibleHeartbeat: [8, null, null],
      rename: [8, null, null],
      stagemove: [8, null, null],
      clock: [8, null, null],
      click: [16, null, 32],
    })
  })
})

describe('targetMismatches', () => {
  it('passes when every arm aimed each change at the same row', () => {
    const noop = run([
      record({ arm: 'noop', target: 'i23' }),
      record({ arm: 'noop', scenario: 'click', target: 'i50' }),
    ])
    const hand = run([
      record({ arm: 'mobx-write', target: 'i23' }),
      record({ arm: 'mobx-write', scenario: 'click', target: 'i50' }),
    ])
    expect(targetMismatches([noop, hand])).toEqual([])
  })

  it('names the cell where two arms timed different rows', () => {
    const noop = run([record({ arm: 'noop', scenario: 'click', target: 'i50' })])
    const control = run([record({ arm: 'control', scenario: 'click', target: 'i17' })])
    expect(targetMismatches([noop, control])).toEqual(['1x click#0: i50 (noop) vs i17 (control)'])
  })

  it('keeps warm-up and measured samples apart', () => {
    const a = run([record({ arm: 'noop', warmup: true, sample: -1, target: 'i1' })])
    const b = run([record({ arm: 'mobx-write', warmup: false, sample: -1, target: 'i2' })])
    expect(targetMismatches([a, b])).toEqual([])
  })
})

describe('runSummary (the entry point)', () => {
  const SCALES: Scale[] = [1, 2, 4]
  /** noop and hand at every scale and scenario, n = 20 per cell: a complete set. */
  const grid = (): RunOutput[] =>
    (['noop', 'mobx-write'] as const).flatMap((arm) => SCALES.map((scale) => completeRun(arm, scale)))

  function write(runs: RunOutput[], names?: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'pod-4558-entry-'))
    runs.forEach((r, i) => {
      writeFileSync(join(dir, names?.[i] ?? `r${i}.json`), JSON.stringify(r))
    })
    return dir
  }

  function summary(dir: string): { code: number; lines: string[] } {
    const lines: string[] = []
    const code = runSummary([dir], (line) => lines.push(line))
    return { code, lines }
  }

  it('summarises a complete set: exit 0, tables printed, no withheld or provisional column', () => {
    const { code, lines } = summary(write(grid()))
    expect(code).toBe(0)
    expect(lines.some((line) => line.startsWith('| mobx-write | click | 4x | 20 |'))).toBe(true)
    const headers = lines.filter((line) => line.startsWith('| Arm |'))
    expect(headers).toHaveLength(2)
    for (const header of headers) expect(header).not.toMatch(/withheld|provisional|n < 20/i)
    expect(lines.join('\n')).not.toMatch(/withheld|provisional|n < 20/i)
  })

  it('refuses a missing cell: exit 2, each shortfall named, no table', () => {
    const runs = grid().filter((r) => !(r.arm === 'mobx-write' && r.scale === 2))
    const { code, lines } = summary(write(runs))
    expect(code).toBe(2)
    expect(lines).toContain('INCOMPLETE (not summarised): cell mobx-write rename 2x: 0 of 20 samples')
    expect(lines.some((line) => line.startsWith('|'))).toBe(false)
  })

  it('refuses a set whose only run of a cell failed, and lists the failed run', () => {
    const runs = grid()
    ;(runs[5] as RunOutput).status = 'failed'
    ;(runs[5] as RunOutput).failures = ['load 8.40 > 8 at click#3']
    const { code, lines } = summary(write(runs))
    expect(code).toBe(2)
    expect(lines[0]).toMatch(
      /^FAILED RUN \(not summarised\): .*r5\.json — load 8\.40 > 8 at click#3$/,
    )
    expect(lines).toContain('INCOMPLETE (not summarised): cell mobx-write click 4x: 0 of 20 samples')
    expect(lines.some((line) => line.startsWith('|'))).toBe(false)
  })

  it('summarises a retried cell: the failed attempt is listed, the passing retry fills the cell', () => {
    const runs = grid()
    const failed: RunOutput = {
      ...completeRun('mobx-write', 4),
      status: 'failed',
      failures: ['load 8.40 > 8 at click#3'],
    }
    const { code, lines } = summary(write([...runs, failed]))
    expect(code).toBe(0)
    expect(lines[0]).toMatch(/^FAILED RUN \(not summarised\): /)
    expect(lines.some((line) => line.startsWith('| mobx-write | click | 4x | 20 |'))).toBe(true)
  })

  it('refuses a record above load 8 even in a run marked ok', () => {
    const runs = grid()
    ;(runs[4]?.records[10] as TimingRecord).loadavg = 8.5
    const { code, lines } = summary(write(runs))
    expect(code).toBe(2)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^INCOMPLETE \(not summarised\): load 8\.50 > 8 at mobx-write 2x /)
  })

  it('holds a matrix directory to its plan', () => {
    const plan: MatrixPlan = {
      arms: ['noop', 'mobx-write'],
      scales: SCALES,
      rounds: 4,
      samples: 5,
      warmup: 1,
      scenarios: [...SCENARIOS_ALL],
      maxLoad: 8,
    }
    const runs: RunOutput[] = []
    const names: string[] = []
    for (let round = 0; round < 4; round += 1) {
      for (const arm of plan.arms as ('noop' | 'mobx-write')[]) {
        for (const scale of SCALES) {
          runs.push(completeRun(arm, scale, { samples: 5 }))
          names.push(matrixRunFile(round, arm, scale))
        }
      }
    }
    const complete = write(runs, names)
    writeFileSync(join(complete, MATRIX_PLAN_FILE), JSON.stringify(plan))
    expect(summary(complete).code).toBe(0)
    // Round 0's noop 1x never passed: cells short, file missing.
    const short = write(runs.slice(1), names.slice(1))
    writeFileSync(join(short, MATRIX_PLAN_FILE), JSON.stringify(plan))
    const { code, lines } = summary(short)
    expect(code).toBe(2)
    expect(lines).toContain('INCOMPLETE (not summarised): cell noop heartbeat 1x: 15 of 20 samples')
    expect(lines).toContain('INCOMPLETE (not summarised): run r0-noop-1x.json: no ok output')
  })

  it('refuses runs whose arms timed different rows: exit 2, no table', () => {
    const runs = grid()
    ;(
      runs[3]?.records.find((r) => r.scenario === 'click' && r.sample === 0) as TimingRecord
    ).target = 'i17'
    const { code, lines } = summary(write(runs))
    expect(code).toBe(2)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^TARGETS DIFFER \(not summarised\): 1x click#0: /)
    expect(lines[0]).toContain('1-click-0 (noop)')
    expect(lines[0]).toContain('i17 (mobx-write)')
  })

  it('refuses runs timed on two machines: exit 2, no table', () => {
    const runs = grid()
    ;(runs[3] as RunOutput).host = 'ludovico'
    const { code, lines } = summary(write(runs))
    expect(code).toBe(2)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^MACHINES DIFFER \(not summarised\): /)
  })
})

describe('excessSlope (the restated slope budget)', () => {
  it('passes constant work above a corpus-growing floor that the raw ratio fails', () => {
    // The measured no-op heartbeat: 14.2 ms at 1x, 34.5 ms at 4x (raw 2.43).
    // An arm adding a constant 5 ms: raw 39.5/19.2 = 2.06, excess 5/5 = 1.
    expect(39.5 / 19.2).toBeGreaterThan(SLOPE_BUDGET)
    expect(excessSlope(19.2, 39.5, 14.2, 34.5)).toBeCloseTo(1, 5)
  })

  it('fails work that grows with the corpus', () => {
    // An arm adding 5 ms per 1x corpus: 5 ms at 1x, 20 ms at 4x.
    expect(excessSlope(19.2, 54.5, 14.2, 34.5)).toBeCloseTo(4, 5)
  })

  it('divides by at least the minimum excess, so noise is not a verdict', () => {
    // 0.2 ms above the floor at 1x and 0.5 ms at 4x: 0.5 / 1, not 0.5 / 0.2.
    expect(excessSlope(0.6, 0.9, 0.4, 0.4)).toBeCloseTo(0.5 / SLOPE_MIN_EXCESS_MS, 5)
    expect(excessSlope(null, 0.9, 0.4, 0.4)).toBeNull()
  })
})
