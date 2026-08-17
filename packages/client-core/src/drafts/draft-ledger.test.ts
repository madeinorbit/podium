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

  // POD-1204: this used to assert the opposite — that a rev moving backwards was
  // ignored as an out-of-order frame. It is not one (frames for a session arrive
  // over one ordered socket); it is the sequencer saying it re-hydrated an older
  // document, and refusing to believe it wedged the session forever.
  it('follows a rev that moves backwards, so the next edit is based on it', () => {
    const ledger = createDraftLedger()
    ledger.adoptRemote(S, { text: 'seed', rev: 9 })
    ledger.localEdit(S, 'seed+', T0)
    expect(ledger.adoptRemote(S, { text: 'old', rev: 2 })).toEqual({
      acceptText: false,
      resend: true,
    })
    expect(ledger.get(S)?.serverRev).toBe(2)
    expect(ledger.get(S)?.text).toBe('seed+') // the person's text still wins
  })
})

// THE WEDGE POD-1204 REPAIRS. The server persists its draft document on a
// debounce, so a restart can reload a rev BELOW the one it already broadcast.
// Every later edit from this device then names a base above the document's, the
// soft lease is long lapsed, and the server rejects it and answers with its own
// rev. While that answer was discarded, the resend was identical to the edit
// that had just been refused — forever — and the composer's clear-on-submit was
// one of the edits that could never land.
describe('a server whose rev rolled back', () => {
  it('converges: the rejected clear is re-sent on the base the server named', () => {
    const ledger = createDraftLedger()
    // Typing, echoed and confirmed up to rev 3.
    ledger.localEdit(S, 'abc', T0)
    ledger.adoptRemote(S, { text: 'abc', rev: 3 })
    expect(ledger.get(S)?.dirty).toBe(false)

    // Enter: the composer clears, and the clear is a draft edit like any other.
    ledger.localEdit(S, '', T0 + 1_000)
    expect(ledger.get(S)?.serverRev).toBe(3)

    // The restarted server rejects it and replies with the document it reloaded.
    const rejected = ledger.adoptRemote(S, { text: 'abc', rev: 2 })
    expect(rejected).toEqual({ acceptText: false, resend: true })

    // The resend now carries baseRev 2 — a base the server can accept — and the
    // text it carries is still the clear.
    expect(ledger.get(S)).toEqual({ text: '', serverRev: 2, dirty: true, editedAt: T0 + 1_000 })

    // Accepted: the echo of the empty document settles the entry.
    expect(ledger.adoptRemote(S, { text: '', rev: 3 })).toEqual({
      acceptText: false,
      resend: false,
    })
    expect(ledger.dirtySessions()).toEqual([])
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
