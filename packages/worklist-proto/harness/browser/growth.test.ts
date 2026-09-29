// POD-4747: the growth test's checks (`growth.ts`) over synthetic --cells matrices.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MATRIX_PLAN_FILE, type MatrixPlan, matrixRunFile } from './complete'
import {
  type GrowthVerdict,
  growthSeries,
  growthShortfalls,
  growthVerdicts,
  plantCaught,
  runGrowth,
} from './growth'
import { type RunOutput, SCENARIOS, type ScenarioName } from './records'
import { completeRun } from './test-fixtures'

const MB = 1e6
const CELLS = ['h1a1', 'h10a1', 'h1a4'] as const
type CellName = (typeof CELLS)[number]
const SCENARIO_SET: ScenarioName[] = [...SCENARIOS, 'coldBootstrap', 'principalSwitch']
const ROUNDS = 4
const SAMPLES = 5

/** What one arm measures at each cell (MB and ms), and how rounds jitter. */
interface Shape {
  armHeap: Record<CellName, number>
  cold: Record<CellName, number>
  /** Every hot-path wall. */
  wall: Record<CellName, number>
  /** A principal switch leaves this much over a cold build. */
  switchLeak?: number
  /** Round r adds r × jitter to every value (so the round spread is 3 × jitter). */
  jitter?: number
  /** POD-4825: per cell, round r adds `noise[cell][r]` to its cold start and walls. */
  noise?: Partial<Record<CellName, readonly number[]>>
}

const flat = (value: number): Record<CellName, number> => ({
  h1a1: value,
  h10a1: value,
  h1a4: value,
})

function cellRun(arm: string, cell: CellName, round: number, shape: Shape): RunOutput {
  const [name, plant] = arm.split('+') as [RunOutput['arm'], string | undefined]
  const run = completeRun(name, cell === 'h1a4' ? 4 : 1, {
    scenarios: SCENARIO_SET,
    samples: SAMPLES,
    ...(plant ? { plant } : {}),
  })
  const bump = round * (shape.jitter ?? 0)
  const noise = shape.noise?.[cell]?.[round] ?? 0
  const engine = cell === 'h10a1' ? 200 : cell === 'h1a4' ? 90 : 40
  run.cell = cell
  for (const record of run.records) {
    record.cell = cell
    if (record.scenario === 'coldBootstrap') {
      record.actionMs = shape.cold[cell] + bump + noise
      record.heapBefore = { usedSize: engine * MB, totalSize: 0 }
      record.heapAfter = { usedSize: (engine + shape.armHeap[cell] + bump) * MB, totalSize: 0 }
      record.lifecycle = { phases: { engineMs: engine * 10 }, midParity: null, survivors: [] }
    } else if (record.scenario === 'principalSwitch') {
      record.actionMs = shape.cold[cell]
      record.heapBefore = { usedSize: (2 * engine + shape.armHeap[cell]) * MB, totalSize: 0 }
      record.heapAfter = {
        usedSize: (engine + shape.armHeap[cell] + bump + (shape.switchLeak ?? 0)) * MB,
        totalSize: 0,
      }
      record.lifecycle = { phases: {}, midParity: null, survivors: [] }
    } else {
      record.actionMs = shape.wall[cell] + bump + noise
    }
  }
  return run
}

const FLOOR: Shape = { armHeap: flat(0.2), cold: flat(40), wall: flat(1), jitter: 0.01 }
const FLAT_ARM: Shape = { armHeap: flat(10), cold: flat(120), wall: flat(3), jitter: 0.05 }

/** A complete matrix: `arms` × CELLS × ROUNDS, with the plan the matrix writes. */
function matrix(arms: Record<string, Shape>, rounds = ROUNDS) {
  const runs: RunOutput[] = []
  const files: string[] = []
  for (let round = 0; round < rounds; round += 1)
    for (const [arm, shape] of Object.entries(arms))
      for (const cell of CELLS) {
        runs.push(cellRun(arm, cell, round, shape))
        files.push(matrixRunFile(round, arm, cell))
      }
  const plan: MatrixPlan = {
    arms: Object.keys(arms),
    scales: [],
    cells: [...CELLS],
    rounds,
    samples: SAMPLES,
    warmup: 1,
    scenarios: SCENARIO_SET,
    maxLoad: 8,
  }
  return { runs, files, plan }
}

function verdictsOf(arms: Record<string, Shape>): GrowthVerdict[] {
  const { runs, files } = matrix(arms)
  return growthVerdicts(growthSeries(runs, files))
}

const pick = (
  verdicts: GrowthVerdict[],
  label: string,
  check: GrowthVerdict['check'],
  metric: string,
): GrowthVerdict | undefined =>
  verdicts.find((v) => v.label === label && v.check === check && v.metric === metric)

describe('history x10: retained heap and cold start stay flat within the round spread', () => {
  it('passes an arm whose heap and cold start do not move', () => {
    const v = verdictsOf({ noop: FLOOR, mobx: FLAT_ARM })
    const heap = pick(v, 'mobx', 'history flat', 'arm heap MB')
    expect(heap?.pass).toBe(true)
    expect(heap?.base).toBeCloseTo(10.075, 6)
    expect(heap?.grown).toBeCloseTo(10.075, 6)
    // The tolerance is read from the rounds: 3 rounds apart at 0.05 each.
    expect(pick(v, 'mobx', 'history flat', 'arm heap MB')?.tolerance).toBeCloseTo(0.15, 6)
    expect(v.filter((x) => x.role === 'arm' && !x.pass)).toEqual([])
  })

  it('fails the planted structure that keeps one object per known issue', () => {
    // hold:1 at 1x keeps ~4.9k objects, at history x10 ~27.6k: about +1 MB.
    const hold: Shape = { ...FLOOR, armHeap: { h1a1: 0.4, h10a1: 1.4, h1a4: 0.7 } }
    const v = verdictsOf({ noop: FLOOR, 'noop+hold:1': hold })
    expect(pick(v, 'noop+hold:1', 'history flat', 'arm heap MB')).toMatchObject({
      role: 'plant',
      pass: false,
    })
    expect(pick(v, 'noop', 'history flat', 'arm heap MB')?.pass).toBe(true)
  })

  it('judges a time check by the paired round growth: inside its t bound passes, past it fails', () => {
    // Round growths (grown_r − base_r) of 1, −2, 3, 0 over the cells' 4 ms:
    // sd √(13/3) = 2.082, so the tolerance is t(0.99, 3) × 2.082 / √4 = 4.727.
    const noise = { h1a1: [0, 2, 0, 1], h10a1: [1, 0, 3, 1] } as const
    const inside: Shape = { ...FLAT_ARM, noise, cold: { h1a1: 120, h10a1: 124, h1a4: 120 } }
    const passing = pick(
      verdictsOf({ noop: FLOOR, mobx: inside }),
      'mobx',
      'history flat',
      'cold start ms',
    )
    expect(passing?.tolerance).toBeCloseTo((4.541 * Math.sqrt(13 / 3)) / 2, 3)
    expect(passing).toMatchObject({ kind: 'time', pass: true })
    const past: Shape = { ...FLAT_ARM, noise, cold: { h1a1: 120, h10a1: 126, h1a4: 120 } }
    expect(
      pick(verdictsOf({ noop: FLOOR, mobx: past }), 'mobx', 'history flat', 'cold start ms')?.pass,
    ).toBe(false)
  })

  it('fails a doubled cold start that the spread of round medians passed', () => {
    // The flatblock shape (POD-4747's matrix): one slow round in each cell.
    // Base rounds 768/639/660/597 (the MobX pool's h1a1 cold start); grown
    // doubles it with a slow first round. The spread of round medians (700)
    // put the bound above the doubling; the paired bound does not.
    const slow: Shape = {
      ...FLAT_ARM,
      jitter: 0,
      cold: { h1a1: 0, h10a1: 0, h1a4: 0 },
      noise: { h1a1: [767.9, 638.6, 660.4, 596.7], h10a1: [1950, 1250, 1300, 1310] },
    }
    const v = pick(verdictsOf({ noop: FLOOR, mobx: slow }), 'mobx', 'history flat', 'cold start ms')
    expect(v?.base).toBeCloseTo(649.5, 6)
    expect(v?.grown).toBeCloseTo(1305, 6)
    const spreadBound = v!.base + Math.max(767.9 - 596.7, 1950 - 1250)
    expect(v!.grown).toBeLessThan(spreadBound)
    expect(v).toMatchObject({ kind: 'time', pass: false })
    expect(v?.blind).toBeUndefined()
  })

  it('reports the booted page (the engine) and never counts it as an arm', () => {
    const v = verdictsOf({ noop: FLOOR, mobx: FLAT_ARM })
    // 40 -> 200 MB: the kernel holds every row by spec today.
    expect(pick(v, 'engine', 'history flat', 'engine heap MB')).toMatchObject({
      role: 'engine',
      base: 40,
      grown: 200,
      pass: false,
    })
  })
})

describe('active x4: heap and cold start at most linear, per-change walls flat', () => {
  it('passes linear growth and fails growth past 4x', () => {
    const linear: Shape = { ...FLAT_ARM, armHeap: { h1a1: 10, h10a1: 10, h1a4: 39 } }
    expect(
      pick(verdictsOf({ noop: FLOOR, mobx: linear }), 'mobx', 'active linear', 'arm heap MB')?.pass,
    ).toBe(true)
    const superlinear: Shape = { ...FLAT_ARM, armHeap: { h1a1: 10, h10a1: 10, h1a4: 45 } }
    const over = pick(
      verdictsOf({ noop: FLOOR, mobx: superlinear }),
      'mobx',
      'active linear',
      'arm heap MB',
    )
    expect(over?.pass).toBe(false)
    expect(over?.bound).toBeCloseTo(4 * 10.075 + 0.15, 6)
  })

  it("judges an arm's wall above the floor's: a slower floor alone passes, the arm's own growth fails", () => {
    const floorUp: Shape = { ...FLOOR, wall: { h1a1: 1, h10a1: 1, h1a4: 3 } }
    const armUp: Shape = { ...FLAT_ARM, wall: { h1a1: 3, h10a1: 3, h1a4: 5 } }
    const both = verdictsOf({ noop: floorUp, mobx: armUp })
    expect(pick(both, 'mobx', 'active flat', 'rename ms over floor')?.pass).toBe(true)
    // The floor's own wall is the kernel's: reported under the engine role.
    expect(pick(both, 'noop', 'active flat', 'rename ms')).toMatchObject({
      pass: false,
      role: 'engine',
    })
    const own = verdictsOf({ noop: FLOOR, mobx: armUp })
    expect(pick(own, 'mobx', 'active flat', 'rename ms over floor')?.pass).toBe(false)
  })
})

describe('what a time check can see (POD-4825)', () => {
  it('prints a wall whose noise hides a doubling of the arm’s own time as blind, never flat', () => {
    // The arm's own time over the floor is 3.2 ms; rounds move it by ±4 ms.
    const noisy: Shape = {
      ...FLAT_ARM,
      wall: flat(4.2),
      jitter: 0,
      noise: { h1a1: [4, -3, 1, -2], h10a1: [-2, 4, -1, 3] },
    }
    const v = pick(
      verdictsOf({ noop: { ...FLOOR, jitter: 0 }, mobx: noisy }),
      'mobx',
      'history flat',
      'rename ms over floor',
    )
    expect(v).toMatchObject({ kind: 'time', pass: true })
    expect(v?.tolerance).toBeGreaterThan(v!.base)
    // At this noise a doubling of 2.7 ms shows after about thirty rounds.
    expect(v?.blind?.roundsToSee).toBeGreaterThan(4)
    expect(v?.blind?.roundsToSee).toBeLessThan(100)
  })

  it('catches the planted slow arm: double:<ms> fails its walls and its cold start', () => {
    // `noop+double:30`: 30 ms per change and per build at h1a1, 60 at a grown
    // cell, over the floor, with the flatblock floor's round noise.
    const noise = { h1a1: [4, -3, 2, -1], h10a1: [-2, 5, -4, 3], h1a4: [3, 1, -3, -2] } as const
    const double: Shape = {
      ...FLOOR,
      jitter: 0,
      noise,
      cold: { h1a1: 70, h10a1: 100, h1a4: 100 },
      wall: { h1a1: 31, h10a1: 61, h1a4: 61 },
    }
    const v = verdictsOf({ noop: { ...FLOOR, jitter: 0 }, 'noop+double:30': double })
    for (const check of ['history flat', 'active flat'] as const) {
      expect(pick(v, 'noop+double:30', check, 'rename ms over floor')).toMatchObject({
        role: 'plant',
        kind: 'time',
        pass: false,
      })
    }
    expect(pick(v, 'noop+double:30', 'history flat', 'cold start ms')?.pass).toBe(false)
    expect(plantCaught(v, 'noop+double:30')).toBe(true)
    // The same plant without the doubling is not caught.
    const constant: Shape = { ...double, cold: flat(70), wall: flat(31) }
    const c = verdictsOf({ noop: { ...FLOOR, jitter: 0 }, 'noop+double:30': constant })
    expect(plantCaught(c, 'noop+double:30')).toBe(false)
  })
})

describe('a principal switch is reported against a cold build', () => {
  it('marks a switch that leaves more than a cold build, and never as an arm failure', () => {
    const leak: Shape = { ...FLOOR, switchLeak: 8 }
    const v = verdictsOf({ noop: FLOOR, 'noop+leak:8': leak })
    expect(pick(v, 'noop+leak:8', 'switch vs cold', 'switch heap MB')).toMatchObject({
      pass: false,
      role: 'report',
    })
    expect(pick(v, 'noop', 'switch vs cold', 'switch heap MB')?.pass).toBe(true)
  })
})

describe('growthShortfalls: a complete --cells matrix or nothing', () => {
  it('accepts a complete matrix', () => {
    const { runs, files, plan } = matrix({ noop: FLOOR, mobx: FLAT_ARM })
    expect(growthShortfalls(runs, files, plan)).toEqual([])
  })

  it('refuses a missing run, a short cell, too few rounds and mixed SHAs', () => {
    const { runs, files, plan } = matrix({ noop: FLOOR, mobx: FLAT_ARM })
    const out = growthShortfalls(runs.slice(1), files.slice(1), plan)
    expect(out).toContain('run r0-noop-h1a1.json: no ok output')
    expect(out).toContain(
      `cell noop h1a1 coldBootstrap: ${(ROUNDS - 1) * SAMPLES} of ${ROUNDS * SAMPLES} samples`,
    )
    const two = matrix({ noop: FLOOR, mobx: FLAT_ARM }, 2)
    expect(growthShortfalls(two.runs, two.files, two.plan)).toContain(
      'plan has 2 rounds: a tolerance needs at least 3',
    )
    const mixed = matrix({ noop: FLOOR, mobx: FLAT_ARM })
    mixed.runs[0]!.runtimeSha = 'def'
    expect(growthShortfalls(mixed.runs, mixed.files, mixed.plan)).toContain(
      'runtime SHAs differ: def, abc',
    )
    expect(growthShortfalls(runs, files, { ...plan, cells: [] })).toEqual([
      'no --cells matrix plan (matrix-plan.json with cells)',
    ])
  })
})

describe('runGrowth over a matrix directory', () => {
  const write = (arms: Record<string, Shape>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-4747-'))
    const { runs, files, plan } = matrix(arms)
    writeFileSync(join(dir, MATRIX_PLAN_FILE), JSON.stringify(plan))
    runs.forEach((run, k) => {
      writeFileSync(join(dir, files[k] as string), JSON.stringify(run))
    })
    return dir
  }

  it('exits 0 when every arm holds, 1 when one grows, and prints the verdict', () => {
    const lines: string[] = []
    expect(runGrowth([write({ noop: FLOOR, mobx: FLAT_ARM })], (l) => lines.push(l))).toBe(0)
    const growing: Shape = { ...FLAT_ARM, armHeap: { h1a1: 10, h10a1: 60, h1a4: 40 } }
    const out: string[] = []
    expect(runGrowth([write({ noop: FLOOR, mobx: growing })], (l) => out.push(l))).toBe(1)
    const row = out.find((l) =>
      l.startsWith('| mobx | history flat | arm heap MB | h1a1 → h10a1 |'),
    )
    expect(row).toMatch(/\| 5\.96 \| 0\.15 \| .* \| GROWS \|$/)
    expect(out).toContain('arms failing a check: mobx')
  })

  it('says so when a plant passes every check it must fail', () => {
    const lines: string[] = []
    expect(runGrowth([write({ noop: FLOOR, 'noop+hold:1': FLOOR })], (l) => lines.push(l))).toBe(1)
    expect(lines).toContain('PLANT NOT CAUGHT: noop+hold:1 passes every check it must fail')
  })

  it('reports the engine and gates on it only with --engine-gate (POD-4825)', () => {
    // The fixture's booted page grows 40 -> 200 MB at history x10 (every arm's).
    const dir = write({ noop: FLOOR, mobx: FLAT_ARM })
    const off: string[] = []
    expect(runGrowth([dir], (l) => off.push(l))).toBe(0)
    expect(off.find((l) => l.startsWith('engine gate:'))).toMatch(
      /^engine gate: off .*engine history flat engine heap MB/,
    )
    const on: string[] = []
    expect(runGrowth([dir, '--engine-gate'], (l) => on.push(l))).toBe(1)
    expect(on.find((l) => l.startsWith('engine gate:'))).toMatch(/^engine gate: ON/)
    expect(on).toContain('arms failing a check: none')
  })
})
