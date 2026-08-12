import type { FlightDeckRow } from '@podium/client-core/viewmodels'
import { describe, expect, it } from 'vitest'
import { applyFolds } from './deck-rows'

function row(id: string, depth: number): FlightDeckRow {
  return { issue: { id }, depth } as unknown as FlightDeckRow
}

const ids = (rows: readonly FlightDeckRow[]) => rows.map((r) => r.issue.id)

describe('applyFolds', () => {
  //   root
  //   ├── a
  //   │   ├── a1
  //   │   │   └── a1x
  //   │   └── a2
  //   └── b
  const spine = [
    row('root', 0),
    row('a', 1),
    row('a1', 2),
    row('a1x', 3),
    row('a2', 2),
    row('b', 1),
  ]

  it('returns the spine untouched when nothing is folded', () => {
    expect(ids(applyFolds(spine, new Set()))).toEqual(['root', 'a', 'a1', 'a1x', 'a2', 'b'])
  })

  it('hides a folded row’s descendants but keeps the row and its siblings', () => {
    expect(ids(applyFolds(spine, new Set(['a'])))).toEqual(['root', 'a', 'b'])
  })

  it('folds a mid-branch without touching what follows at the same depth', () => {
    expect(ids(applyFolds(spine, new Set(['a1'])))).toEqual(['root', 'a', 'a1', 'a2', 'b'])
  })

  it('folding the root leaves only the root', () => {
    expect(ids(applyFolds(spine, new Set(['root'])))).toEqual(['root'])
  })

  it('a fold inside an already-folded branch changes nothing — the outer one wins', () => {
    expect(ids(applyFolds(spine, new Set(['a', 'a1'])))).toEqual(['root', 'a', 'b'])
  })

  it('ignores ids that are not in the spine', () => {
    expect(ids(applyFolds(spine, new Set(['ghost'])))).toEqual(ids(spine))
  })
})
