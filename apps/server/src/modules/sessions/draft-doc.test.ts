import { describe, expect, it } from 'vitest'
import {
  applyDraftEdit,
  DEFAULT_HISTORY_LIMIT,
  type DraftDoc,
  emptyDraftDoc,
  leaseHolder,
} from './draft-doc'

// Fixed clock so lease-window math is deterministic. All `at`/`now` inputs are
// derived from this base — the pure engine never reads the wall clock itself.
const BASE = Date.parse('2026-07-17T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString()

const doc = (over: Partial<DraftDoc> = {}): DraftDoc => ({
  sessionId: 's1',
  text: 'hello',
  rev: 3,
  origin: 'clientA',
  editedAt: iso(0),
  history: [],
  ...over,
})

describe('emptyDraftDoc', () => {
  it('is an empty, never-edited seed at rev 0', () => {
    const d = emptyDraftDoc('s9')
    expect(d).toEqual({
      sessionId: 's9',
      text: '',
      rev: 0,
      origin: 'seed',
      editedAt: '',
      history: [],
    })
  })
})

describe('applyDraftEdit — clean apply (baseRev matches)', () => {
  it('bumps rev, updates text/origin/editedAt', () => {
    const r = applyDraftEdit(doc(), {
      baseRev: 3,
      text: 'hello world',
      origin: 'clientB',
      at: iso(10),
    })
    expect(r.status).toBe('applied')
    if (r.status !== 'applied') throw new Error('unreachable')
    expect(r.changed).toBe(true)
    expect(r.doc.text).toBe('hello world')
    expect(r.doc.rev).toBe(4)
    expect(r.doc.origin).toBe('clientB')
    expect(r.doc.editedAt).toBe(iso(10))
  })

  it('is a no-op when the text is unchanged (rev unchanged, changed=false)', () => {
    const before = doc()
    const r = applyDraftEdit(before, { baseRev: 3, text: 'hello', origin: 'clientB', at: iso(10) })
    expect(r.status).toBe('applied')
    if (r.status !== 'applied') throw new Error('unreachable')
    expect(r.changed).toBe(false)
    expect(r.doc).toEqual(before)
  })

  it('pushes superseded non-empty text into history', () => {
    const r = applyDraftEdit(doc({ text: 'old', history: [] }), {
      baseRev: 3,
      text: 'new',
      origin: 'clientA',
      at: iso(10),
    })
    if (r.status !== 'applied') throw new Error('unreachable')
    expect(r.doc.history).toEqual(['old'])
    expect(r.doc.text).toBe('new')
  })

  it('does not push an empty superseded text into history', () => {
    const r = applyDraftEdit(doc({ text: '', rev: 3, history: [] }), {
      baseRev: 3,
      text: 'typed',
      origin: 'clientA',
      at: iso(10),
    })
    if (r.status !== 'applied') throw new Error('unreachable')
    expect(r.doc.history).toEqual([])
  })

  it('clearing a draft (empty text) keeps the old text in history and bumps rev', () => {
    const r = applyDraftEdit(doc({ text: 'draft to send', rev: 3 }), {
      baseRev: 3,
      text: '',
      origin: 'clientA',
      at: iso(10),
    })
    if (r.status !== 'applied') throw new Error('unreachable')
    expect(r.doc.text).toBe('')
    expect(r.doc.rev).toBe(4)
    expect(r.doc.history).toEqual(['draft to send'])
  })
})

describe('applyDraftEdit — history ring', () => {
  it('caps history at the limit, dropping the oldest', () => {
    let d = doc({ text: 'v0', rev: 0, history: [] })
    for (let i = 1; i <= DEFAULT_HISTORY_LIMIT + 2; i++) {
      const r = applyDraftEdit(d, { baseRev: d.rev, text: `v${i}`, origin: 'clientA', at: iso(i) })
      if (r.status !== 'applied') throw new Error('unreachable')
      d = r.doc
    }
    expect(d.history).toHaveLength(DEFAULT_HISTORY_LIMIT)
    // v0 and v1 fell off the front; the ring holds the most recent superseded texts.
    expect(d.history[0]).toBe('v2')
    expect(d.history.at(-1)).toBe(`v${DEFAULT_HISTORY_LIMIT + 1}`)
  })

  it('dedupes: re-superseding an existing entry moves it to the newest slot', () => {
    let d = doc({ text: 'a', rev: 0, history: [] })
    const step = (text: string, n: number) => {
      const r = applyDraftEdit(d, { baseRev: d.rev, text, origin: 'clientA', at: iso(n) })
      if (r.status !== 'applied') throw new Error('unreachable')
      d = r.doc
    }
    step('b', 1) // history: [a]
    step('a', 2) // supersede b; history dedupes to [b] then... a was already gone
    expect(d.text).toBe('a')
    // 'b' superseded most recently; 'a' pushed earlier then re-becomes current.
    expect(d.history).toEqual(['a', 'b'])
    step('a', 3) // no-op text? current is 'a', edit 'a' → no change
    expect(d.history).toEqual(['a', 'b'])
    step('b', 4) // supersede 'a'; 'a' already in history → dedupe+move to newest
    expect(d.history).toEqual(['b', 'a'])
  })
})

describe('applyDraftEdit — stale baseRev arbitration', () => {
  it('accepts a stale edit from the lease-holder (same origin, within window)', () => {
    // clientA edited at t0 (rev 3); a second clientA edit lagged the echo (baseRev 2).
    const r = applyDraftEdit(doc({ origin: 'clientA', rev: 3, editedAt: iso(0) }), {
      baseRev: 2,
      text: 'more from A',
      origin: 'clientA',
      at: iso(200), // within 1.5s lease
    })
    expect(r.status).toBe('applied')
    if (r.status !== 'applied') throw new Error('unreachable')
    expect(r.doc.text).toBe('more from A')
    expect(r.doc.rev).toBe(4)
  })

  it('rejects a stale edit from a different origin (not the lease-holder)', () => {
    const current = doc({ origin: 'clientA', rev: 3, editedAt: iso(0) })
    const r = applyDraftEdit(current, {
      baseRev: 2,
      text: 'stale from B',
      origin: 'clientB',
      at: iso(200),
    })
    expect(r.status).toBe('rejected')
    if (r.status !== 'rejected') throw new Error('unreachable')
    // Rejection returns the authoritative doc unchanged so the sender rebases.
    expect(r.doc).toEqual(current)
  })

  it('rejects a stale edit from the same origin once the lease has expired', () => {
    const current = doc({ origin: 'clientA', rev: 3, editedAt: iso(0) })
    const r = applyDraftEdit(current, {
      baseRev: 2,
      text: 'late from A',
      origin: 'clientA',
      at: iso(5000), // 5s later, lease (1.5s) long gone
    })
    expect(r.status).toBe('rejected')
  })
})

describe('applyDraftEdit — fresh edit wins, loser to history', () => {
  it('a fresh chat edit wins while native holds the lease; native text goes to history', () => {
    // native typed most recently (rev 5). A chat client with a CURRENT baseRev (5)
    // submits — it is accepted (fresh), and the superseded native text is preserved.
    const current = doc({ origin: 'native', text: 'native text', rev: 5, editedAt: iso(0) })
    const r = applyDraftEdit(current, {
      baseRev: 5,
      text: 'chat text',
      origin: 'clientB',
      at: iso(100),
    })
    expect(r.status).toBe('applied')
    if (r.status !== 'applied') throw new Error('unreachable')
    expect(r.doc.text).toBe('chat text')
    expect(r.doc.origin).toBe('clientB')
    expect(r.doc.history).toContain('native text')
  })
})

describe('leaseHolder', () => {
  it('returns the origin while within the lease window', () => {
    expect(leaseHolder(doc({ origin: 'clientA', editedAt: iso(0), rev: 3 }), BASE + 1000)).toBe(
      'clientA',
    )
  })

  it('returns null once the window has passed', () => {
    expect(leaseHolder(doc({ origin: 'clientA', editedAt: iso(0), rev: 3 }), BASE + 5000)).toBe(
      null,
    )
  })

  it('returns null for a never-edited (rev 0) doc', () => {
    expect(leaseHolder(emptyDraftDoc('s1'), BASE)).toBe(null)
  })
})
