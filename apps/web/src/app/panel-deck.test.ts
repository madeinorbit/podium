import type { SplitNode, WorkspaceLayout } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  composeDeck,
  type DeckTab,
  deckGeometry,
  paneDropId,
  resizedSizes,
  resolveTabDrop,
  splitDropId,
  stripDropId,
} from './panel-deck'
import type { FileTab } from './store'

// A minimal session tab — composeDeck only reads `id`/`kind`, so the SessionMeta
// body is a cast stub.
const sessionTab = (id: string): DeckTab => ({
  id,
  kind: 'session',
  session: { sessionId: id } as SessionMeta,
})
const fileTab = (id: string): DeckTab => ({
  id,
  kind: 'file',
  file: { id, scope: 'x', path: `/tmp/${id}` } as unknown as FileTab,
})

describe('composeDeck', () => {
  it('renders the current workspace tabs, marking the active pane visible', () => {
    const deck = composeDeck({
      tabs: [sessionTab('s1'), sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      panes: [{ id: 'p1', activeTabId: 's1' }],
    })
    expect(deck.map((d) => d.id)).toEqual(['s1', 's2'])
    expect(deck.find((d) => d.id === 's1')).toMatchObject({ paneId: 'p1', foreign: false })
    expect(deck.find((d) => d.id === 's2')).toMatchObject({ paneId: null, foreign: false })
  })

  it('(a) keeps a previously-viewed session from another issue mounted (foreign, hidden)', () => {
    // Viewing issue B (its tab is s2, active) while s1 — from issue A — is warm.
    const deck = composeDeck({
      tabs: [sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      panes: [{ id: 'p1', activeTabId: 's2' }],
    })
    const s1 = deck.find((d) => d.id === 's1')
    const s2 = deck.find((d) => d.id === 's2')
    // s1 is in the deck as a foreign warm panel — mounted but never visible/active.
    expect(s1).toMatchObject({ foreign: true, warm: true, paneId: null })
    // s2 is the current, active tab.
    expect(s2).toMatchObject({ foreign: false, paneId: 'p1' })
  })

  it('(e) the foreign warm session is NOT a current tab — only s2 belongs to the strip', () => {
    // The tab strip is composed from `allTabs` upstream; the deck adds foreign
    // panels beyond it. Only non-foreign deck items correspond to strip tabs.
    const deck = composeDeck({
      tabs: [sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      panes: [{ id: 'p1', activeTabId: 's2' }],
    })
    const stripIds = deck.filter((d) => !d.foreign).map((d) => d.id)
    expect(stripIds).toEqual(['s2'])
    expect(deck.some((d) => d.id === 's1' && d.foreign)).toBe(true)
  })

  it('never renders a warm session twice when it IS a current tab', () => {
    const deck = composeDeck({
      tabs: [sessionTab('s1'), sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      panes: [{ id: 'p1', activeTabId: 's1' }],
    })
    expect(deck.filter((d) => d.id === 's1')).toHaveLength(1)
    expect(deck.some((d) => d.foreign)).toBe(false)
  })

  it('(c) respects the cap: a warm set capped upstream renders only those foreign panels', () => {
    // useWarmSet caps the warm set at N (8 desktop); composeDeck faithfully
    // renders whatever survived the cap. Here s0 was evicted (not in warm), so it
    // never appears in the deck even though it is still a live session.
    const warm = new Set(['s8', 's7', 's6', 's5', 's4', 's3', 's2', 's1']) // 8, cap
    const known = new Set([...warm, 's0'])
    const deck = composeDeck({
      tabs: [sessionTab('s8')],
      warm,
      knownSessionIds: known,
      panes: [{ id: 'p1', activeTabId: 's8' }],
    })
    expect(deck.some((d) => d.id === 's0')).toBe(false)
    // The other 7 warm sessions ride along as foreign panels.
    expect(
      deck
        .filter((d) => d.foreign)
        .map((d) => d.id)
        .sort(),
    ).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7'])
  })

  it('(d) drops a foreign panel whose session was killed/archived (left knownSessionIds)', () => {
    // s1 is still lingering in the warm set (the LRU updates a render behind) but
    // it was archived, so it is no longer a known live session — the deck evicts it.
    const deck = composeDeck({
      tabs: [sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s2']), // s1 archived/killed
      panes: [{ id: 'p1', activeTabId: 's2' }],
    })
    expect(deck.some((d) => d.id === 's1')).toBe(false)
    expect(deck.map((d) => d.id)).toEqual(['s2'])
  })

  // A pane the `tab-splitting` flag is hiding is simply absent from `panes`: its
  // active tab stays MOUNTED (warm) but claims no box, which is what makes
  // flipping the flag back on a reveal rather than a remount.
  it('gives each on-screen pane its active tab, and a hidden pane none', () => {
    const on = composeDeck({
      tabs: [sessionTab('s1'), sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      panes: [
        { id: 'p1', activeTabId: 's1' },
        { id: 'p2', activeTabId: 's2' },
      ],
    })
    expect(on.find((d) => d.id === 's1')).toMatchObject({ paneId: 'p1' })
    expect(on.find((d) => d.id === 's2')).toMatchObject({ paneId: 'p2' })
    const off = composeDeck({
      tabs: [sessionTab('s1'), sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      panes: [{ id: 'p1', activeTabId: 's1' }],
    })
    expect(off.find((d) => d.id === 's2')).toMatchObject({ paneId: null, warm: true })
  })

  it('carries file tabs through, always warm', () => {
    const deck = composeDeck({
      tabs: [sessionTab('s1'), fileTab('file:abc')],
      warm: new Set(['s1']),
      knownSessionIds: new Set(['s1']),
      panes: [{ id: 'p1', activeTabId: 's1' }],
    })
    const file = deck.find((d) => d.id === 'file:abc')
    expect(file).toMatchObject({ kind: 'file', foreign: false })
    expect(file?.file).toBeDefined()
  })
})

const leaf = (paneId: string): SplitNode => ({ kind: 'leaf', paneId })

describe('deckGeometry', () => {
  it('gives a lone pane the whole deck and no seam', () => {
    const g = deckGeometry(leaf('p1'))
    expect(g.panes).toEqual([{ paneId: 'p1', left: 0, top: 0, width: 1, height: 1 }])
    expect(g.seams).toEqual([])
  })

  // `row` is Split Right: the panes sit side by side, so the boundary is vertical
  // and it is the WIDTHS that carry the sizes.
  it('lays a row split out side by side, with one seam at the boundary', () => {
    const g = deckGeometry({
      kind: 'split',
      axis: 'row',
      children: [leaf('p1'), leaf('p2')],
      sizes: [0.3, 0.7],
    })
    expect(g.panes).toEqual([
      { paneId: 'p1', left: 0, top: 0, width: 0.3, height: 1 },
      { paneId: 'p2', left: 0.3, top: 0, width: 0.7, height: 1 },
    ])
    expect(g.seams).toMatchObject([{ axis: 'row', index: 0, at: 0.3, path: [] }])
  })

  it('stacks a column split, and nests both axes', () => {
    const g = deckGeometry({
      kind: 'split',
      axis: 'row',
      children: [
        leaf('p1'),
        { kind: 'split', axis: 'column', children: [leaf('p2'), leaf('p3')], sizes: [0.5, 0.5] },
      ],
      sizes: [0.5, 0.5],
    })
    expect(g.panes).toEqual([
      { paneId: 'p1', left: 0, top: 0, width: 0.5, height: 1 },
      { paneId: 'p2', left: 0.5, top: 0, width: 0.5, height: 0.5 },
      { paneId: 'p3', left: 0.5, top: 0.5, width: 0.5, height: 0.5 },
    ])
    // The inner seam spans only the half of the deck its split occupies.
    expect(g.seams).toMatchObject([
      { axis: 'row', index: 0, at: 0.5, path: [] },
      { axis: 'column', index: 0, at: 0.5, path: [1], left: 0.5, width: 0.5 },
    ])
  })

  // Persisted layout is device state and may be hand-edited or half-written; it
  // must still lay out rather than produce NaN boxes.
  it('falls back to equal shares for sizes that do not describe the children', () => {
    const g = deckGeometry({
      kind: 'split',
      axis: 'row',
      children: [leaf('p1'), leaf('p2')],
      sizes: [0],
    })
    expect(g.panes.map((p) => p.width)).toEqual([0.5, 0.5])
  })
})

describe('resizedSizes', () => {
  it('moves one boundary and leaves the panes beyond it alone', () => {
    expect(resizedSizes([0.25, 0.25, 0.5], 1, 0.75, 0.1)).toEqual([0.25, 0.5, 0.25])
  })

  it('refuses to squeeze either side below the minimum', () => {
    expect(resizedSizes([0.5, 0.5], 0, 0.01, 0.15)).toEqual([0.15, 0.85])
    const wide = resizedSizes([0.5, 0.5], 0, 0.99, 0.15)
    expect(wide[0]).toBeCloseTo(0.85)
    expect(wide[1]).toBeCloseTo(0.15)
  })

  it('is a no-op on a pair with no room, or a boundary that is not there', () => {
    expect(resizedSizes([0.1, 0.1, 0.8], 0, 0.5, 0.2)).toEqual([0.1, 0.1, 0.8])
    expect(resizedSizes([1], 0, 0.5, 0.1)).toEqual([1])
  })
})

describe('resolveTabDrop', () => {
  const split: WorkspaceLayout = {
    key: 'mission:t',
    panes: {
      p1: { id: 'p1', tabs: ['s1', 's2'], activeTabId: 's1' },
      p2: { id: 'p2', tabs: ['s3'], activeTabId: 's3' },
    },
    root: {
      kind: 'split',
      axis: 'row',
      children: [
        { kind: 'leaf', paneId: 'p1' },
        { kind: 'leaf', paneId: 'p2' },
      ],
      sizes: [0.5, 0.5],
    },
    focusedPaneId: 'p1',
    previewTabId: null,
  }

  it("lands on another pane's tab at that tab's index", () => {
    expect(resolveTabDrop(split, 's1', 's3')).toEqual({
      kind: 'move',
      tabId: 's1',
      paneId: 'p2',
      index: 0,
    })
  })

  it('reorders inside one pane, which is the same move', () => {
    expect(resolveTabDrop(split, 's1', 's2')).toEqual({
      kind: 'move',
      tabId: 's1',
      paneId: 'p1',
      index: 1,
    })
  })

  it("appends when the drop is the other pane's strip or body", () => {
    expect(resolveTabDrop(split, 's1', stripDropId('p2'))).toEqual({
      kind: 'move',
      tabId: 's1',
      paneId: 'p2',
      index: 1,
    })
    expect(resolveTabDrop(split, 's1', paneDropId('p2'))).toMatchObject({ kind: 'move', index: 1 })
  })

  // Dropping back into the pane it came from must not send the tab to the end.
  it("treats a drop into the tab's own pane as a selection", () => {
    expect(resolveTabDrop(split, 's1', stripDropId('p1'))).toEqual({
      kind: 'activate',
      tabId: 's1',
    })
  })

  it('splits on a trailing edge zone, on either axis', () => {
    expect(resolveTabDrop(split, 's3', splitDropId('row', 'p1'))).toEqual({
      kind: 'split',
      tabId: 's3',
      paneId: 'p1',
      axis: 'row',
    })
    expect(resolveTabDrop(split, 's3', splitDropId('column', 'p1'))).toMatchObject({
      axis: 'column',
    })
  })

  it('resolves to nothing for a target that is gone, or for itself', () => {
    expect(resolveTabDrop(split, 's1', 's1')).toBeNull()
    expect(resolveTabDrop(split, 's1', stripDropId('p9'))).toBeNull()
    expect(resolveTabDrop(split, 's1', 'not-a-tab')).toBeNull()
  })
})
