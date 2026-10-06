/**
 * POD-4747 — the two-axis cells (`buildCorpusCell`). The base cell is the 1x
 * corpus. History x10 adds history and leaves every active row, the scan,
 * the lanes and the oracle's list exactly as they were; active x4 adds active
 * work and leaves every history row exactly as it was; and at every cell each
 * axis keeps the base cell's shape. Which axis a row is on is read from the
 * rows and the oracle (`splitAxes`), never from the generator's own labels,
 * so a builder that grows the wrong axis fails here.
 */
import { describe, expect, it } from 'vitest'
import {
  buildCorpus,
  buildCorpusCell,
  cellLabel,
  type FixtureCorpus,
  GROWTH_CELLS,
  parseCell,
} from './index'
import {
  type AxisMeasures,
  axisRows,
  firstAxisDifference,
  measureAxes,
  splitAxes,
  type TwoAxisMeasures,
} from './shape'

const cells: Record<keyof typeof GROWTH_CELLS, FixtureCorpus> = {
  base: buildCorpusCell(GROWTH_CELLS.base),
  history10: buildCorpusCell(GROWTH_CELLS.history10),
  active4: buildCorpusCell(GROWTH_CELLS.active4),
}
const measured: Record<keyof typeof GROWTH_CELLS, TwoAxisMeasures> = {
  base: measureAxes(cells.base),
  history10: measureAxes(cells.history10),
  active4: measureAxes(cells.active4),
}
const names = Object.keys(cells) as (keyof typeof GROWTH_CELLS)[]

/** A share is compared once the base cell holds this many of the thing; a
 *  rarer one (three `waits-on` edges) swings by more than 20% on one edge,
 *  so it only has to be present wherever the base has it. */
const MIN_COMPARED = 25
const TOLERANCE = 0.2

/** Every share of `cell` more than 20% off the base's (or missing), named. */
function shapeDeviations(base: AxisMeasures, cell: AxisMeasures): string[] {
  const out: string[] = []
  const compare = (
    kind: string,
    of: (m: AxisMeasures) => number,
    shares: (m: AxisMeasures) => Record<string, number>,
  ): void => {
    const keys = new Set([...Object.keys(shares(base)), ...Object.keys(shares(cell))])
    for (const key of keys) {
      const want = shares(base)[key] ?? 0
      const got = shares(cell)[key] ?? 0
      if (want * of(base) < MIN_COMPARED) {
        if (want > 0 && got === 0) out.push(`${kind} ${key}: absent (base ${want.toFixed(4)})`)
        continue
      }
      const deviation = Math.abs(got - want) / want
      if (deviation > TOLERANCE)
        out.push(
          `${kind} ${key}: ${got.toFixed(4)} vs base ${want.toFixed(4)} (${(100 * deviation).toFixed(0)}%)`,
        )
    }
  }
  compare(
    'per issue',
    (m) => m.issues,
    (m) => m.issueShares,
  )
  compare(
    'per session',
    (m) => m.sessions,
    (m) => m.sessionShares,
  )
  compare(
    'per visible row',
    (m) => m.visibleRows,
    (m) => m.rowShares,
  )
  return out
}

describe('cell labels', () => {
  it('round-trip and refuse anything else', () => {
    expect(cellLabel(GROWTH_CELLS.history10)).toBe('h10a1')
    expect(parseCell('h10a1')).toEqual(GROWTH_CELLS.history10)
    expect(parseCell('h1a4')).toEqual(GROWTH_CELLS.active4)
    for (const bad of ['h0a1', 'h1a3', 'h21a1', '10x', 'h1a1 '])
      expect(() => parseCell(bad)).toThrow(/bad cell/)
  })
})

describe('the base cell', () => {
  it('is buildCorpus(1), row for row', () => {
    const { cell, units, ...rest } = cells.base
    const { cell: legacyCell, units: _legacyUnits, ...legacy } = buildCorpus(1, 4443)
    expect(cell).toEqual({ history: 1, active: 1 })
    expect(legacyCell).toBeNull()
    expect(units.map((u) => u.part)).toEqual(['full'])
    expect(rest).toEqual(legacy)
  })

  it('builds deterministically, and a different seed moves the added units too', () => {
    const cell = { history: 2, active: 2 } as const
    expect(buildCorpusCell(cell, 4443)).toEqual(buildCorpusCell(cell, 4443))
    const a = buildCorpusCell(cell, 4443)
    const b = buildCorpusCell(cell, 777)
    for (const part of ['active', 'history'] as const) {
      const at = a.units.find((u) => u.part === part)!.issues[0]
      expect(a.issues[at]).not.toEqual(b.issues[at])
    }
  })
})

describe.each(names)('%s: every unit is on its axis, read from the rows', (name) => {
  it('history epochs hold only history, active units only active work', () => {
    const corpus = cells[name]
    const split = splitAxes(corpus)
    const off: string[] = []
    corpus.units.forEach((u, k) => {
      if (u.part === 'full') return
      const want = u.part === 'history'
      for (const issue of corpus.issues.slice(...u.issues))
        if (split.historyIssues.has(issue.id) !== want) off.push(`unit ${k} issue ${issue.id}`)
      for (const s of corpus.sessions.slice(...u.sessions))
        if (split.historySessions.has(s.sessionId) !== want)
          off.push(`unit ${k} session ${s.sessionId}`)
    })
    expect(off.slice(0, 5)).toEqual([])
  })
})

describe('history x10 at constant active work', () => {
  const { base, history10 } = measured

  it('multiplies history issues and sessions by exactly 10', () => {
    expect(history10.history.issues).toBe(10 * base.history.issues)
    expect(history10.history.sessions).toBe(10 * base.history.sessions)
    // Tens of thousands of issues (the target scale, I2).
    expect(cells.history10.issues.length).toBeGreaterThan(25_000)
  })

  it('leaves every active row, the scan, the lanes and the oracle list as they were', () => {
    expect(
      firstAxisDifference(axisRows(cells.base, 'active'), axisRows(cells.history10, 'active')),
    ).toBeNull()
    expect(history10.active).toEqual(base.active)
  })

  it('control: one retitled active row is a difference', () => {
    const planted = structuredClone(cells.history10)
    const visible = [...splitAxes(planted).visibleRows][0]!
    const at = planted.issues.findIndex((i) => i.id === visible)
    planted.issues[at] = { ...planted.issues[at]!, title: 'planted' }
    expect(firstAxisDifference(axisRows(cells.base, 'active'), axisRows(planted, 'active'))).toBe(
      `issue:${visible}: differs`,
    )
  })
})

describe('active x4 at constant history', () => {
  const { base, active4 } = measured

  it('multiplies active issues, sessions, lanes and visible rows by exactly 4', () => {
    expect(active4.active.issues).toBe(4 * base.active.issues)
    expect(active4.active.sessions).toBe(4 * base.active.sessions)
    expect(active4.active.lanes).toBe(4 * base.active.lanes)
    expect(active4.active.visibleRows).toBe(4 * base.active.visibleRows)
  })

  it('leaves every history row as it was', () => {
    expect(
      firstAxisDifference(axisRows(cells.base, 'history'), axisRows(cells.active4, 'history')),
    ).toBeNull()
    expect(active4.history).toEqual(base.history)
  })
})

describe.each(names)('%s keeps each axis shaped like the base cell (L2b)', (name) => {
  it.each(['history', 'active'] as const)('%s: every share within 20% of the base', (axis) => {
    expect(shapeDeviations(measured.base[axis], measured[name][axis])).toEqual([])
  })
})
