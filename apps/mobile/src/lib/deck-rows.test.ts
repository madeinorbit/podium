import type { FlightDeckRow } from '@podium/client-core/viewmodels'
import { describe, expect, it } from 'vitest'
import { BAND_H, STRIP_H } from '../components/spine'
import { applyFolds, type DeckTally, deckContentHeight, deckPanelHeight } from './deck-rows'

function row(id: string, depth: number): FlightDeckRow {
  return {
    issue: { id },
    depth,
    descendantIds: [],
    sessions: [],
  } as unknown as FlightDeckRow
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
    expect(ids(applyFolds(spine, new Map()))).toEqual(['root', 'a', 'a1', 'a1x', 'a2', 'b'])
  })

  it('hides a folded row’s descendants but keeps the row and its siblings', () => {
    expect(ids(applyFolds(spine, new Map([['a', 'closed']])))).toEqual(['root', 'a', 'b'])
  })

  it('folds a mid-branch without touching what follows at the same depth', () => {
    expect(ids(applyFolds(spine, new Map([['a1', 'closed']])))).toEqual([
      'root',
      'a',
      'a1',
      'a2',
      'b',
    ])
  })

  it('folding the root leaves only the root', () => {
    expect(ids(applyFolds(spine, new Map([['root', 'closed']])))).toEqual(['root'])
  })

  it('a fold inside an already-folded branch changes nothing — the outer one wins', () => {
    expect(
      ids(
        applyFolds(
          spine,
          new Map([
            ['a', 'closed'],
            ['a1', 'closed'],
          ]),
        ),
      ),
    ).toEqual(['root', 'a', 'b'])
  })

  it('ignores ids that are not in the spine', () => {
    expect(ids(applyFolds(spine, new Map([['ghost', 'closed']])))).toEqual(ids(spine))
  })

  it('uses the shared default fold for a one-session leaf and respects an explicit open', () => {
    // The deeper synthetic row makes the fold observable to this flat-list
    // helper. In production the leaf has no task child; the same fold hides its
    // one session band in MissionDeck.
    const leaf = { ...row('leaf', 1), sessions: [{}] } as unknown as FlightDeckRow
    const child = row('hidden', 2)
    expect(ids(applyFolds([leaf, child], new Map()))).toEqual(['leaf'])
    expect(ids(applyFolds([leaf, child], new Map([['leaf', 'open']])))).toEqual(['leaf', 'hidden'])
  })
})

const tally = (partial: Partial<DeckTally> = {}): DeckTally => ({
  strips: 0,
  bands: 0,
  proposals: 0,
  departures: 0,
  signposts: 0,
  sections: 0,
  empty: false,
  ...partial,
})

describe('deckContentHeight', () => {
  it('charges each strip and band at the spine’s own row constants', () => {
    const chrome = deckContentHeight(tally())
    expect(deckContentHeight(tally({ strips: 3 }))).toBe(chrome + 3 * STRIP_H)
    expect(deckContentHeight(tally({ bands: 2 }))).toBe(chrome + 2 * BAND_H)
  })

  it('charges the tail regions — sections, proposals, departures, signposts', () => {
    const chrome = deckContentHeight(tally())
    const proposed = deckContentHeight(tally({ sections: 1, proposals: 2 }))
    expect(proposed).toBeGreaterThan(chrome)
    // A second row costs a row, not a second section head.
    expect(deckContentHeight(tally({ sections: 1, proposals: 3 })) - proposed).toBeLessThan(
      proposed - chrome,
    )
    expect(deckContentHeight(tally({ signposts: 1 }))).toBeGreaterThan(chrome)
    expect(deckContentHeight(tally({ sections: 1, departures: 1 }))).toBeGreaterThan(chrome)
  })

  it('an empty deck still charges for the EmptyState it renders', () => {
    expect(deckContentHeight(tally({ empty: true }))).toBeGreaterThan(deckContentHeight(tally()))
  })
})

describe('deckPanelHeight', () => {
  const max = 523 // 62% of an 844pt window — the historical fixed height.

  it('stands at the cap until the deck has reported', () => {
    expect(deckPanelHeight(null, max)).toBe(max)
  })

  it('a two-item mission no longer claims two thirds of the screen', () => {
    const twoItems = deckContentHeight(tally({ strips: 1, bands: 1 }))
    const panel = deckPanelHeight(twoItems, max)
    expect(panel).toBeLessThan(max)
    // The grab edge rides below the deck, so the panel is taller than content.
    expect(panel).toBeGreaterThan(twoItems)
  })

  it('never opens as a sliver: floored at the controls plus a couple of strips', () => {
    const floor = deckPanelHeight(0, max)
    expect(floor).toBeGreaterThan(2 * STRIP_H)
    expect(deckPanelHeight(deckContentHeight(tally({ empty: true })), max)).toBeGreaterThanOrEqual(
      floor,
    )
  })

  it('caps a tall mission at the fraction and lets the deck scroll internally', () => {
    const tall = deckContentHeight(tally({ strips: 12, bands: 12 }))
    expect(tall).toBeGreaterThan(max)
    expect(deckPanelHeight(tall, max)).toBe(max)
  })

  it('the cap wins even over the floor on an implausibly short window', () => {
    expect(deckPanelHeight(0, 120)).toBe(120)
  })
})
