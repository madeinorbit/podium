// POD-4558 (L5b): the driver summary's statistics and refusals.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { distribution, MIN_SAMPLES_FOR_P95, type RunOutput, type TimingRecord } from './records'
import { allowanceMs, cells, loadRuns } from './summarize'

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
      run([record({ actionMs: 500, warmup: true }), record({ actionMs: 1 }), record({ actionMs: 3 })]),
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
    writeFileSync(join(dir, 'failed.json'), JSON.stringify(run([record({ actionMs: 999 })], 'failed')))
    const { ok, failed } = loadRuns([dir])
    expect(ok).toHaveLength(1)
    expect(failed.map((f) => f.path)).toEqual([join(dir, 'failed.json')])
    expect(cells(ok)[0]?.actionMs.max).toBe(1)
  })
})

describe('allowanceMs', () => {
  it('budgets the hot path at live corpus and the click at 1x and 4x', () => {
    expect(allowanceMs('rename', 1)).toBe(8)
    expect(allowanceMs('rename', 4)).toBeNull()
    expect(allowanceMs('click', 1)).toBe(16)
    expect(allowanceMs('click', 4)).toBe(32)
    expect(allowanceMs('click', 2)).toBeNull()
  })
})
