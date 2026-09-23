// POD-4558 (L5b): the driver summary's statistics and refusals.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { distribution, MIN_SAMPLES_FOR_P95, type RunOutput, type TimingRecord } from './records'
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

function record(overrides: Partial<TimingRecord>): TimingRecord {
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
})

describe('targetMismatches', () => {
  it('passes when every arm aimed each change at the same row', () => {
    const noop = run([
      record({ arm: 'noop', target: 'i23' }),
      record({ arm: 'noop', scenario: 'click', target: 'i50' }),
    ])
    const hand = run([
      record({ arm: 'hand', target: 'i23' }),
      record({ arm: 'hand', scenario: 'click', target: 'i50' }),
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
    const b = run([record({ arm: 'hand', warmup: false, sample: -1, target: 'i2' })])
    expect(targetMismatches([a, b])).toEqual([])
  })
})

describe('runSummary (the entry point)', () => {
  function write(runs: RunOutput[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'pod-4558-entry-'))
    runs.forEach((r, i) => writeFileSync(join(dir, `r${i}.json`), JSON.stringify(r)))
    return dir
  }

  it('refuses runs whose arms timed different rows: exit 2, no table', () => {
    const dir = write([
      run([record({ arm: 'noop', scenario: 'click', target: 'i50' })]),
      run([record({ arm: 'hand', scenario: 'click', target: 'i17' })]),
    ])
    const lines: string[] = []
    expect(runSummary([dir], (line) => lines.push(line))).toBe(2)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^TARGETS DIFFER \(not summarised\): 1x click#0: /)
    expect(lines[0]).toContain('i50 (noop)')
    expect(lines[0]).toContain('i17 (hand)')
    expect(lines.some((line) => line.startsWith('|'))).toBe(false)
  })

  it('summarises runs whose arms timed the same rows: exit 0, tables printed', () => {
    const dir = write([
      run([record({ arm: 'noop', scenario: 'click', target: 'i50' })]),
      run([record({ arm: 'hand', scenario: 'click', target: 'i50', actionMs: 3 })]),
    ])
    const lines: string[] = []
    expect(runSummary([dir], (line) => lines.push(line))).toBe(0)
    expect(lines.some((line) => line.startsWith('| hand | click | 1x |'))).toBe(true)
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
