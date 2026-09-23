// POD-4561 (L5e): the lifecycle cells' completeness and their control-relative budgets.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gridShortfalls, MATRIX_PLAN_FILE, type MatrixPlan, matrixRunFile } from './complete'
import { LIFECYCLE_SCENARIOS, MIN_SAMPLES_FOR_P95, type RunOutput } from './records'
import {
  HEAP_GROWTH_ALLOWANCE,
  lifecycleCells,
  lifecycleVerdicts,
  RETAINED_HEAP_BUDGET,
  runSummary,
} from './summarize'
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
    expect(gridShortfalls([CONTROL, lifecycleRun('hand')], { minSamples: 20 })).toEqual([])
  })

  it('refuses an arm without the control its budgets are multiples of', () => {
    const out = gridShortfalls([lifecycleRun('hand')], { minSamples: 20 })
    expect(out).toContain('cell control coldBootstrap 1x: 0 of 20 samples')
    expect(out).toContain('cell control rescope 1x: 0 of 20 samples')
  })

  it('does not ask a lifecycle-only set for the no-op floor', () => {
    const out = gridShortfalls([CONTROL, lifecycleRun('hand')], { minSamples: 20 })
    expect(out.some((line) => line.includes('noop'))).toBe(false)
  })

  it('holds a lifecycle matrix to its planned scales', () => {
    const plan: MatrixPlan = {
      arms: ['control', 'hand'],
      scales: [1],
      rounds: 4,
      samples: 5,
      warmup: 1,
      scenarios: [...LIFECYCLE_SCENARIOS],
      maxLoad: 8,
    }
    const runs = [0, 1, 2, 3].flatMap(() => [
      lifecycleRun('control', { samples: 5 }),
      lifecycleRun('hand', { samples: 5 }),
    ])
    const files = [0, 1, 2, 3].flatMap((round) => [
      matrixRunFile(round, 'control', 1),
      matrixRunFile(round, 'hand', 1),
    ])
    expect(gridShortfalls(runs, { minSamples: 20, plan, files })).toEqual([])
    const out = gridShortfalls(runs.slice(1), { minSamples: 20, plan, files: files.slice(1) })
    expect(out).toContain('cell control principalSwitch 1x: 15 of 20 samples')
    expect(out).toContain('run r0-control-1x.json: no ok output')
  })
})

describe('lifecycleVerdicts (methodology §1a, multiples of the control)', () => {
  const verdictsOf = (arm: RunOutput) => lifecycleVerdicts(lifecycleCells([CONTROL, arm]))

  it('passes an arm at the control on every check', () => {
    const verdicts = verdictsOf(
      lifecycleRun('hand', {
        heap: { coldBootstrap: [20, 22], principalSwitch: [24, 22], rescope: [36, 42] },
      }),
    )
    expect(verdicts.map((v) => `${v.scenario} ${v.check}`).sort()).toEqual([
      'coldBootstrap retained heap',
      'coldBootstrap wall',
      'principalSwitch heap growth',
      'principalSwitch wall',
      'rescope heap growth',
    ])
    expect(verdicts.every((v) => v.verdict === 'within')).toBe(true)
  })

  it('fails a cold bootstrap over 1.1x the control and a switch over 2x', () => {
    const slow = verdictsOf(lifecycleRun('hand', { wall: 111 }))
    expect(slow.find((v) => v.scenario === 'coldBootstrap' && v.check === 'wall')).toMatchObject({
      control: 100,
      verdict: 'OVER',
    })
    expect(slow.find((v) => v.scenario === 'principalSwitch' && v.check === 'wall')?.verdict).toBe(
      'within',
    )
    const slower = verdictsOf(lifecycleRun('hand', { wall: 201 }))
    expect(
      slower.find((v) => v.scenario === 'principalSwitch' && v.check === 'wall')?.verdict,
    ).toBe('OVER')
  })

  it('fails a retained heap over 1.1x the control after cold bootstrap', () => {
    const heavy = verdictsOf(lifecycleRun('mobx', { heap: { coldBootstrap: [20, 22 * 1.11] } }))
    const retained = heavy.find((v) => v.check === 'retained heap')
    expect(retained).toMatchObject({ control: 22, verdict: 'OVER' })
    expect(retained?.budget).toBeCloseTo(22 * RETAINED_HEAP_BUDGET, 5)
  })

  it('fails growth past the control plus 5% after a switch or a rescope (the leak plant)', () => {
    // The control: 24 -> 22 MB on a switch (0.917), 36 -> 42 MB on a rescope (1.167).
    const leak = verdictsOf(
      lifecycleRun('noop', {
        plant: 'leak:8',
        heap: { principalSwitch: [32, 38.9], rescope: [44.9, 67.2] },
      }),
    )
    const growth = leak
      .filter((v) => v.check === 'heap growth')
      .sort((a, b) => a.scenario.localeCompare(b.scenario))
    expect(growth.map((v) => [v.scenario, v.verdict])).toEqual([
      ['principalSwitch', 'OVER'],
      ['rescope', 'OVER'],
    ])
    expect(growth[0]?.budget).toBeCloseTo(22 / 24 + HEAP_GROWTH_ALLOWANCE, 5)
    // Growth inside the band passes: the kernel's own growth is the control's too.
    const within = verdictsOf(lifecycleRun('hand', { heap: { rescope: [40, 40 * 1.2] } }))
    expect(within.find((v) => v.scenario === 'rescope')?.verdict).toBe('within')
  })

  it('gives the control no verdict: it is the reference', () => {
    expect(lifecycleVerdicts(lifecycleCells([CONTROL])).map((v) => v.arm)).toEqual([])
  })
})

describe('runSummary over a lifecycle-only set', () => {
  it('prints the lifecycle tables and no hot-path table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-4561-'))
    writeFileSync(join(dir, 'control.json'), JSON.stringify(CONTROL))
    writeFileSync(join(dir, 'hand.json'), JSON.stringify(lifecycleRun('hand', { wall: 250 })))
    const lines: string[] = []
    expect(runSummary([dir], (line) => lines.push(line))).toBe(0)
    const headers = lines.filter((line) => line.startsWith('| Arm |'))
    expect(headers).toHaveLength(2)
    expect(headers[0]).toContain('| Lifecycle |')
    expect(lines).toContain(
      '| hand | coldBootstrap | 1x | wall | 250.00 | 100.00 | 110.00 | OVER |',
    )
    expect(lines).toContain(
      '| hand | principalSwitch | 1x | wall | 250.00 | 100.00 | 200.00 | OVER |',
    )
  })

  it('refuses a lifecycle set with a short control cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-4561-'))
    writeFileSync(
      join(dir, 'control.json'),
      JSON.stringify(lifecycleRun('control', { samples: 19 })),
    )
    writeFileSync(join(dir, 'hand.json'), JSON.stringify(lifecycleRun('hand')))
    const lines: string[] = []
    expect(runSummary([dir], (line) => lines.push(line))).toBe(2)
    expect(lines).toContain(
      'INCOMPLETE (not summarised): cell control coldBootstrap 1x: 19 of 20 samples',
    )
  })
})
