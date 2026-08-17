import { asSessionId } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import { createDraftLedger } from './draft-ledger'

const S = asSessionId('s1')
const OTHER = asSessionId('s2')
const T0 = Date.parse('2026-08-14T12:00:00.000Z')

describe('a fresh session', () => {
  it('has no entry until something writes one', () => {
    expect(createDraftLedger().get(S)).toBeUndefined()
  })

  it('accepts an incoming draft outright when nothing local exists', () => {
    const ledger = createDraftLedger()
    expect(ledger.adoptRemote(S, { text: 'from another device', rev: 4 })).toEqual({
      acceptText: true,
      resend: false,
    })
    expect(ledger.get(S)).toEqual({
      text: 'from another device',
      serverRev: 4,
      dirty: false,
      editedAt: 0,
    })
  })

  it('does not ask the view to repaint a draft it already shows', () => {
    const ledger = createDraftLedger()
    ledger.adoptRemote(S, { text: 'same', rev: 1 })
    expect(ledger.adoptRemote(S, { text: 'same', rev: 2 })).toEqual({
      acceptText: false,
      resend: false,
    })
    expect(ledger.get(S)?.serverRev).toBe(2)
  })
})

describe('a local edit', () => {
  it('is dirty, stamped, and keeps the last known server rev as its base', () => {
    const ledger = createDraftLedger()
    ledger.adoptRemote(S, { text: 'seed', rev: 7 })
    ledger.localEdit(S, 'seed and more', T0)
    expect(ledger.get(S)).toEqual({
      text: 'seed and more',
      serverRev: 7,
      dirty: true,
      editedAt: T0,
    })
  })

  it('starts from rev 0 when the server has never spoken', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, 'offline typing', T0)
    expect(ledger.get(S)).toEqual({ text: 'offline typing', serverRev: 0, dirty: true, editedAt: T0 })
  })
})

// THE BUG THIS LEDGER EXISTS FOR (POD-2045): a slow server drops keystroke
// frames, reconnects, and replays a draft older than what the person has typed
// since. Adopting that text is how a paragraph disappears mid-sentence.
describe('a stale replay against local typing', () => {
  it('never overwrites newer local text, and re-offers the local text instead', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, 'hello world', T0)
    expect(ledger.adoptRemote(S, { text: 'hello', rev: 3 })).toEqual({
      acceptText: false,
      resend: true,
    })
    const local = ledger.get(S)
    expect(local?.text).toBe('hello world')
    expect(local?.dirty).toBe(true)
    // The rev IS adopted: the resend must be based on what the server has now,
    // or the server rejects it as stale and the two never converge.
    expect(local?.serverRev).toBe(3)
  })

  it('holds the line against a legacy server that sends no rev at all', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, 'hello world', T0)
    expect(ledger.adoptRemote(S, { text: 'hello' })).toEqual({ acceptText: false, resend: true })
    expect(ledger.get(S)?.text).toBe('hello world')
    expect(ledger.get(S)?.serverRev).toBe(0)
  })

  it('ignores a rev that moves backwards', () => {
    const ledger = createDraftLedger()
    ledger.adoptRemote(S, { text: 'seed', rev: 9 })
    ledger.localEdit(S, 'seed+', T0)
    ledger.adoptRemote(S, { text: 'old', rev: 2 })
    expect(ledger.get(S)?.serverRev).toBe(9)
  })
})

describe('the echo of our own edit', () => {
  it('converges the entry to clean without touching the text', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, 'hello world', T0)
    expect(ledger.adoptRemote(S, { text: 'hello world', rev: 4 })).toEqual({
      acceptText: false,
      resend: false,
    })
    expect(ledger.get(S)).toEqual({
      text: 'hello world',
      serverRev: 4,
      dirty: false,
      editedAt: T0,
    })
  })

  it('leaves a keystroke that landed after the send still dirty', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, 'hello', T0)
    ledger.localEdit(S, 'hello!', T0 + 10)
    expect(ledger.adoptRemote(S, { text: 'hello', rev: 4 })).toEqual({
      acceptText: false,
      resend: true,
    })
    expect(ledger.get(S)?.dirty).toBe(true)
  })
})

describe('the reconnect flush set', () => {
  it('lists exactly the sessions holding unsent text', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, 'unsent', T0)
    ledger.adoptRemote(OTHER, { text: 'clean', rev: 1 })
    expect(ledger.dirtySessions()).toEqual([S])
  })

  it('empties as edits converge', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, 'unsent', T0)
    ledger.adoptRemote(S, { text: 'unsent', rev: 1 })
    expect(ledger.dirtySessions()).toEqual([])
  })

  it('counts a local clear as something to send', () => {
    const ledger = createDraftLedger()
    ledger.adoptRemote(S, { text: 'was here', rev: 1 })
    ledger.localEdit(S, '', T0)
    expect(ledger.dirtySessions()).toEqual([S])
  })
})

describe('persistence across a reload', () => {
  it('round-trips the text and its base rev', () => {
    const ledger = createDraftLedger()
    ledger.adoptRemote(S, { text: 'seed', rev: 5 })
    ledger.localEdit(S, 'seed and mine', T0)
    const restored = createDraftLedger()
    restored.restore(ledger.snapshot())
    expect(restored.get(S)?.text).toBe('seed and mine')
    expect(restored.get(S)?.serverRev).toBe(5)
  })

  // A restored draft may never have reached the server — the tab could have
  // closed with the socket down. Offering it again costs one no-op edit the
  // server dedups; NOT offering it loses the text on the other devices forever.
  it('marks restored text dirty so the next connect re-offers it', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, 'typed offline', T0)
    const restored = createDraftLedger()
    restored.restore(ledger.snapshot())
    expect(restored.get(S)?.dirty).toBe(true)
    expect(restored.dirtySessions()).toEqual([S])
  })

  it('does not carry empty drafts across', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, '', T0)
    expect(ledger.snapshot()).toEqual({})
  })

  it('survives a snapshot with junk in it', () => {
    const ledger = createDraftLedger()
    ledger.restore({
      [S]: { text: 'good', serverRev: 2, editedAt: T0 },
      bad: null as never,
      worse: { text: 5 as never, serverRev: 'x' as never, editedAt: T0 },
    })
    expect(ledger.get(S)?.text).toBe('good')
    expect(ledger.dirtySessions()).toEqual([S])
  })
})

describe('forgetting a session', () => {
  it('drops it from the entries and the flush set', () => {
    const ledger = createDraftLedger()
    ledger.localEdit(S, 'text', T0)
    ledger.remove(S)
    expect(ledger.get(S)).toBeUndefined()
    expect(ledger.dirtySessions()).toEqual([])
  })
})
