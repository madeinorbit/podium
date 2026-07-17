import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { composeDeck, type DeckTab } from './panel-deck'
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
      paneA: 's1',
      paneB: null,
      split: false,
    })
    expect(deck.map((d) => d.id)).toEqual(['s1', 's2'])
    expect(deck.find((d) => d.id === 's1')).toMatchObject({ inA: true, foreign: false })
    expect(deck.find((d) => d.id === 's2')).toMatchObject({ inA: false, foreign: false })
  })

  it('(a) keeps a previously-viewed session from another issue mounted (foreign, hidden)', () => {
    // Viewing issue B (its tab is s2, active) while s1 — from issue A — is warm.
    const deck = composeDeck({
      tabs: [sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      paneA: 's2',
      paneB: null,
      split: false,
    })
    const s1 = deck.find((d) => d.id === 's1')
    const s2 = deck.find((d) => d.id === 's2')
    // s1 is in the deck as a foreign warm panel — mounted but never visible/active.
    expect(s1).toMatchObject({ foreign: true, warm: true, inA: false, inB: false })
    // s2 is the current, active tab.
    expect(s2).toMatchObject({ foreign: false, inA: true })
  })

  it('(e) the foreign warm session is NOT a current tab — only s2 belongs to the strip', () => {
    // The tab strip is composed from `allTabs` upstream; the deck adds foreign
    // panels beyond it. Only non-foreign deck items correspond to strip tabs.
    const deck = composeDeck({
      tabs: [sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      paneA: 's2',
      paneB: null,
      split: false,
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
      paneA: 's1',
      paneB: null,
      split: false,
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
      paneA: 's8',
      paneB: null,
      split: false,
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
      paneA: 's2',
      paneB: null,
      split: false,
    })
    expect(deck.some((d) => d.id === 's1')).toBe(false)
    expect(deck.map((d) => d.id)).toEqual(['s2'])
  })

  it('marks pane B visible only when split is on', () => {
    const on = composeDeck({
      tabs: [sessionTab('s1'), sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      paneA: 's1',
      paneB: 's2',
      split: true,
    })
    expect(on.find((d) => d.id === 's2')).toMatchObject({ inB: true })
    const off = composeDeck({
      tabs: [sessionTab('s1'), sessionTab('s2')],
      warm: new Set(['s1', 's2']),
      knownSessionIds: new Set(['s1', 's2']),
      paneA: 's1',
      paneB: 's2',
      split: false,
    })
    expect(off.find((d) => d.id === 's2')).toMatchObject({ inB: false })
  })

  it('carries file tabs through, always warm', () => {
    const deck = composeDeck({
      tabs: [sessionTab('s1'), fileTab('file:abc')],
      warm: new Set(['s1']),
      knownSessionIds: new Set(['s1']),
      paneA: 's1',
      paneB: null,
      split: false,
    })
    const file = deck.find((d) => d.id === 'file:abc')
    expect(file).toMatchObject({ kind: 'file', foreign: false })
    expect(file?.file).toBeDefined()
  })
})
