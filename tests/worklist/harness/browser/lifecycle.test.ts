// POD-4561 (L5e): the lifecycle cells' completeness and their report. POD-4747
// removed G6's control-relative budgets (the growth test, `growth.ts`,
// replaces them): the summary reports lifecycle and judges none of it.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gridShortfalls, MATRIX_PLAN_FILE, type MatrixPlan, matrixRunFile } from './complete'
import { LIFECYCLE_SCENARIOS, MIN_SAMPLES_FOR_P95, type RunOutput } from './records'
import { runSummary } from './summarize'
import { completeRun } from './test-fixtures'

const MB = 1e6

/** One complete lifecycle run at 1x: every record the same wall and heap. */
function lifecycleRun(
  arm: RunOutput['arm'],
  shape: {
    wall?: number
    /** heapBefore / heapAfter usedSize (MB) per scenario. */
    heap?: Partial<Record<(typeof LIFECYCLE_SCENARIOS)[number], [number, number]>>
    plant?: string
    samples?: number
  } = {},
): RunOutput {
  const run = completeRun(arm, 1, {
    scenarios: [...LIFECYCLE_SCENARIOS],
    samples: shape.samples ?? MIN_SAMPLES_FOR_P95,
    ...(shape.plant ? { plant: shape.plant } : {}),
  })
  for (const record of run.records) {
    const scenario = record.scenario as (typeof LIFECYCLE_SCENARIOS)[number]
    const [before, after] = shape.heap?.[scenario] ?? [20, 22]
    record.target = null
    record.actionMs = shape.wall ?? 100
    record.heapBefore = { usedSize: before * MB, totalSize: 64 * MB }
    record.heapAfter = { usedSize: after * MB, totalSize: 64 * MB }
    record.lifecycle = { phases: { buildMs: 10 }, midParity: null, survivors: [] }
  }
  return run
}

const CONTROL = lifecycleRun('control', {
  wall: 100,
  heap: { coldBootstrap: [20, 22], principalSwitch: [24, 22], rescope: [36, 42] },
})

describe('gridShortfalls over lifecycle cells', () => {
  it('passes the control and an arm at 1x only: lifecycle needs no 2x or 4x', () => {
    expect(gridShortfalls([CONTROL, lifecycleRun('mobx-write')], { minSamples: 20 })).toEqual([])
  })

  it('refuses an arm without the control its budgets are multiples of', () => {
    const out = gridShortfalls([lifecycleRun('mobx-write')], { minSamples: 20 })
    expect(out).toContain('cell control coldBootstrap 1x: 0 of 20 samples')
    expect(out).toContain('cell control rescope 1x: 0 of 20 samples')
  })

  it('does not ask a lifecycle-only set for the no-op floor', () => {
    const out = gridShortfalls([CONTROL, lifecycleRun('mobx-write')], { minSamples: 20 })
    expect(out.some((line) => line.includes('noop'))).toBe(false)
  })

  it('holds a lifecycle matrix to its planned scales', () => {
    const plan: MatrixPlan = {
      arms: ['control', 'mobx-write'],
      scales: [1],
      rounds: 4,
      samples: 5,
      warmup: 1,
      scenarios: [...LIFECYCLE_SCENARIOS],
      maxLoad: 8,
    }
    const runs = [0, 1, 2, 3].flatMap(() => [
      lifecycleRun('control', { samples: 5 }),
      lifecycleRun('mobx-write', { samples: 5 }),
    ])
    const files = [0, 1, 2, 3].flatMap((round) => [
      matrixRunFile(round, 'control', 1),
      matrixRunFile(round, 'mobx-write', 1),
    ])
    expect(gridShortfalls(runs, { minSamples: 20, plan, files })).toEqual([])
    const out = gridShortfalls(runs.slice(1), { minSamples: 20, plan, files: files.slice(1) })
    expect(out).toContain('cell control principalSwitch 1x: 15 of 20 samples')
    expect(out).toContain('run r0-control-1x.json: no ok output')
  })
})

describe('runSummary over a lifecycle-only set', () => {
  it('prints the lifecycle table, no hot-path table and no control-relative verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-4561-'))
    writeFileSync(join(dir, 'control.json'), JSON.stringify(CONTROL))
    writeFileSync(join(dir, 'mobx-write.json'), JSON.stringify(lifecycleRun('mobx-write', { wall: 250 })))
    const lines: string[] = []
    expect(runSummary([dir], (line) => lines.push(line))).toBe(0)
    const headers = lines.filter((line) => line.startsWith('| Arm |'))
    expect(headers).toHaveLength(1)
    expect(headers[0]).toContain('| Lifecycle |')
    // 2.5x the control's wall is reported, and judged nowhere here (POD-4747).
    expect(lines.some((line) => line.startsWith('| mobx-write | coldBootstrap | 1x |'))).toBe(true)
    expect(lines.some((line) => /OVER|within/.test(line))).toBe(false)
  })

  it('refuses a cells matrix: the growth test summarises it (POD-4747)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-4747-'))
    writeFileSync(join(dir, 'control.json'), JSON.stringify({ ...CONTROL, cell: 'h10a1' }))
    const lines: string[] = []
    expect(runSummary([dir], (line) => lines.push(line))).toBe(2)
    expect(lines).toContain(
      'CELL RUNS (not summarised here): summarise a --cells matrix with growth.ts',
    )
  })

  it('refuses a lifecycle set with a short control cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-4561-'))
    writeFileSync(
      join(dir, 'control.json'),
      JSON.stringify(lifecycleRun('control', { samples: 19 })),
    )
    writeFileSync(join(dir, 'mobx-write.json'), JSON.stringify(lifecycleRun('mobx-write')))
    const lines: string[] = []
    expect(runSummary([dir], (line) => lines.push(line))).toBe(2)
    expect(lines).toContain(
      'INCOMPLETE (not summarised): cell control coldBootstrap 1x: 19 of 20 samples',
    )
  })
})
