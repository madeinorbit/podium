/**
 * The pending-interactions aggregate's status guards as they are TODAY, pinned
 * before the drizzle conversion [POD-3394, method §3 checklist item 10].
 *
 * `openByFingerprint`, `reopen`, `retireClaimed` and `closeSession` are in the
 * coverage census's (POD-3244) "executed, but never named" column: they reach a
 * test only through `modules/interactions/`.
 *
 * WHAT THIS FILE IS ABOUT is the set of `WHERE status = …` clauses, because in
 * this aggregate they are not filters — each one IS an idempotency claim, and
 * the file's own comments say so method by method. Four of them differ from
 * each other deliberately and a conversion that regularised them would be
 * silent:
 *
 *   - `close` reaches an `asked` row; `retireClaimed` reaches an `answered` one.
 *     The two exist precisely because neither can reach the other's row.
 *   - `reopen` and `retireClaimed` also guard on WHO answered, so a correction
 *     aimed at a policy answer can never retire a human's row underneath it.
 *   - `answer` guards on `asked` and `recordDelivery` on `answered`, which is
 *     why they are two statements rather than one.
 *   - `reopen` clears four columns to NULL and sets `policy_verdict`. A
 *     conversion that dropped one clear would leave a reopened ask carrying the
 *     answer it was reopened for.
 *
 * The dedupe index and the retention rule are pinned here too, because both are
 * expressed in SQL rather than in the service.
 */

import type { SessionId } from '@podium/model'
import type { InteractionAnswer } from '@podium/protocol'
import { expect, it } from 'vitest'
import type { InteractionInsert } from './interactions'
import { openTestStore } from '../test-support/open-test-store'

const session = 'sess-1' as SessionId
const answer: InteractionAnswer = { kind: 'permission', decision: 'allow-once' }

function ask(overrides: Partial<InteractionInsert> = {}): InteractionInsert {
  return {
    id: 'int-1',
    sessionId: session,
    kind: 'permission',
    payload: { tool: 'Bash' },
    source: 'protocol',
    answerable: 'structured',
    fingerprint: 'fp-1',
    askedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

it('collapses a duplicate open ask onto the existing row and says it did not insert', async () => {
  const store = await openTestStore(':memory:')
  try {
    const first = store.interactions.insert(ask())
    expect(first.inserted).toBe(true)
    expect(first.row.status).toBe('asked')
    expect(first.row.payload).toEqual({ tool: 'Bash' })

    // Same session, same fingerprint, different id: the partial unique index
    // decides, and the caller is told not to re-announce.
    const second = store.interactions.insert(ask({ id: 'int-2' }))
    expect(second.inserted).toBe(false)
    expect(second.row.id).toBe('int-1')
    expect(store.interactions.get('int-2')).toBeNull()

    // A different session asking the same question is a different ask.
    const elsewhere = store.interactions.insert(
      ask({ id: 'int-3', sessionId: 'sess-2' as SessionId }),
    )
    expect(elsewhere.inserted).toBe(true)
  } finally {
    store.close()
  }
})

it('re-asks after the first was resolved, because the dedupe index covers open rows only', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.interactions.insert(ask())
    expect(store.interactions.answer({
      id: 'int-1',
      answer,
      answeredBy: 'human',
      deliveredVia: 'menu',
      at: '2026-09-01T00:01:00.000Z',
    })).toBe(true)

    // The same question again is a genuinely new ask — a long session hits the
    // same permission prompt repeatedly and each one needs its own answer.
    const again = store.interactions.insert(ask({ id: 'int-2' }))
    expect(again.inserted).toBe(true)
    expect(again.row.id).toBe('int-2')

    // `openByFingerprint` sees only the open one, never the answered one.
    expect(store.interactions.openByFingerprint(session, 'fp-1')?.id).toBe('int-2')
    expect(store.interactions.openByFingerprint(session, 'fp-absent')).toBeNull()
  } finally {
    store.close()
  }
})

it('answers exactly once, and records delivery only after the row was claimed', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.interactions.insert(ask())

    // `recordDelivery` guards on `answered`, so before the claim it reaches
    // nothing. That asymmetry is why these are two statements and not one.
    expect(store.interactions.recordDelivery('int-1', 'structured')).toBe(false)

    const at = '2026-09-01T00:01:00.000Z'
    expect(store.interactions.answer({ id: 'int-1', answer, answeredBy: 'human', deliveredVia: 'unverified', at })).toBe(true)
    // The second answer loses the race and is told so.
    expect(store.interactions.answer({ id: 'int-1', answer, answeredBy: 'policy', deliveredVia: 'menu', at })).toBe(false)

    expect(store.interactions.recordDelivery('int-1', 'structured')).toBe(true)
    const row = store.interactions.get('int-1')
    expect(row).toMatchObject({
      status: 'answered',
      answeredBy: 'human',
      deliveredVia: 'structured',
      answeredAt: at,
    })
    expect(row?.answer).toEqual(answer)
  } finally {
    store.close()
  }
})

it('reopens only the class of answer it was aimed at, and clears every trace of that answer', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.interactions.insert(ask())
    store.interactions.answer({
      id: 'int-1',
      answer,
      answeredBy: 'policy',
      deliveredVia: 'structured',
      at: '2026-09-01T00:01:00.000Z',
    })

    // Aimed at the wrong class: the row does not move.
    expect(store.interactions.reopen('int-1', 'human')).toBe(false)
    expect(store.interactions.get('int-1')?.status).toBe('answered')

    expect(store.interactions.reopen('int-1', 'policy')).toBe(true)
    const row = store.interactions.get('int-1')
    // FOUR CLEARS AND ONE SET. A reopened ask that still carried its answer
    // would be back on the list and already answered at the same time.
    expect(row).toMatchObject({
      status: 'asked',
      answer: null,
      answeredBy: null,
      deliveredVia: null,
      answeredAt: null,
      policyVerdict: 'escalated',
    })
    // Back on the enumeration, which is the whole point of reopening.
    expect(store.interactions.listOpen(session).map((r) => r.id)).toEqual(['int-1'])

    // An already-open row cannot be reopened again.
    expect(store.interactions.reopen('int-1', 'policy')).toBe(false)
  } finally {
    store.close()
  }
})

it('retires a claimed row that close cannot reach, and close reaches the open one that retire cannot', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.interactions.insert(ask({ id: 'claimed', fingerprint: 'fp-claimed' }))
    store.interactions.insert(ask({ id: 'open', fingerprint: 'fp-open' }))
    const at = '2026-09-01T00:02:00.000Z'
    store.interactions.answer({
      id: 'claimed',
      answer,
      answeredBy: 'policy',
      deliveredVia: 'structured',
      at: '2026-09-01T00:01:00.000Z',
    })

    // THE ASYMMETRY. `close` guards on `asked`; `retireClaimed` on `answered`.
    expect(store.interactions.close('claimed', 'expired', at)).toBe(false)
    expect(store.interactions.retireClaimed('open', 'expired', at, 'policy')).toBe(false)

    // And retire is guarded on who claimed it, exactly like reopen.
    expect(store.interactions.retireClaimed('claimed', 'expired', at, 'human')).toBe(false)
    expect(store.interactions.retireClaimed('claimed', 'expired', at, 'policy')).toBe(true)
    expect(store.interactions.get('claimed')).toMatchObject({ status: 'expired', expiredAt: at })

    expect(store.interactions.close('open', 'superseded', at)).toBe(true)
    expect(store.interactions.get('open')).toMatchObject({ status: 'superseded', expiredAt: at })
    // Both statuses share `expired_at`: it is when the row stopped being open.
    expect(store.interactions.close('open', 'expired', at)).toBe(false)
  } finally {
    store.close()
  }
})

it('closes every open ask on one session at once and returns exactly the ids that moved', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.interactions.insert(ask({ id: 'a', fingerprint: 'fp-a', askedAt: '2026-09-01T00:00:00.000Z' }))
    store.interactions.insert(ask({ id: 'b', fingerprint: 'fp-b', askedAt: '2026-09-01T00:01:00.000Z' }))
    store.interactions.insert(ask({ id: 'c', fingerprint: 'fp-c', askedAt: '2026-09-01T00:02:00.000Z' }))
    store.interactions.insert(ask({ id: 'other', sessionId: 'sess-2' as SessionId, fingerprint: 'fp-a' }))
    const at = '2026-09-01T00:03:00.000Z'
    store.interactions.answer({ id: 'b', answer, answeredBy: 'human', deliveredVia: 'menu', at })

    // The already-answered row is not returned and is not touched: the ids are
    // read from `listOpen` before the update, so they are exactly the movers.
    expect(store.interactions.closeSession(session, 'expired', at)).toEqual(['a', 'c'])
    expect(store.interactions.get('a')).toMatchObject({ status: 'expired', expiredAt: at })
    expect(store.interactions.get('c')).toMatchObject({ status: 'expired', expiredAt: at })
    expect(store.interactions.get('b')?.status).toBe('answered')
    // Another session's open ask is untouched.
    expect(store.interactions.get('other')?.status).toBe('asked')

    // Nothing open: an empty list, and no statement issued.
    expect(store.interactions.closeSession(session, 'expired', at)).toEqual([])
  } finally {
    store.close()
  }
})

it('enumerates open asks oldest first and a session’s history newest first', async () => {
  const store = await openTestStore(':memory:')
  try {
    store.interactions.insert(ask({ id: 'a', fingerprint: 'fp-a', askedAt: '2026-09-01T00:02:00.000Z' }))
    store.interactions.insert(ask({ id: 'b', fingerprint: 'fp-b', askedAt: '2026-09-01T00:01:00.000Z' }))
    store.interactions.insert(ask({ id: 'c', fingerprint: 'fp-c', askedAt: '2026-09-01T00:03:00.000Z' }))
    store.interactions.insert(ask({ id: 'z', sessionId: 'sess-2' as SessionId, fingerprint: 'fp-a' }))

    expect(store.interactions.listOpen(session).map((r) => r.id)).toEqual(['b', 'a', 'c'])
    // No session argument means every session's open asks.
    expect(store.interactions.listOpen().map((r) => r.id)).toEqual(['z', 'b', 'a', 'c'])

    expect(store.interactions.listForSession(session).map((r) => r.id)).toEqual(['c', 'a', 'b'])
    expect(store.interactions.listForSession(session, 2).map((r) => r.id)).toEqual(['c', 'a'])
  } finally {
    store.close()
  }
})

it('trims resolved rows by age and never trims an open ask, however old', async () => {
  const store = await openTestStore(':memory:')
  try {
    const old = '2026-01-01T00:00:00.000Z'
    store.interactions.insert(ask({ id: 'ancient-open', fingerprint: 'fp-1', askedAt: old }))
    store.interactions.insert(ask({ id: 'answered-old', fingerprint: 'fp-2', askedAt: old }))
    store.interactions.insert(ask({ id: 'closed-old', fingerprint: 'fp-3', askedAt: old }))
    store.interactions.insert(ask({ id: 'answered-new', fingerprint: 'fp-4', askedAt: old }))
    store.interactions.answer({ id: 'answered-old', answer, answeredBy: 'human', deliveredVia: 'menu', at: '2026-02-01T00:00:00.000Z' })
    store.interactions.close('closed-old', 'expired', '2026-02-01T00:00:00.000Z')
    store.interactions.answer({ id: 'answered-new', answer, answeredBy: 'human', deliveredVia: 'menu', at: '2026-06-01T00:00:00.000Z' })

    // The cutoff is compared against the resolution time, not the ask time —
    // COALESCE(answered_at, expired_at, asked_at) — so `answered-new` survives
    // a cutoff that its `asked_at` alone would have put on the wrong side.
    expect(store.interactions.pruneResolvedBefore('2026-03-01T00:00:00.000Z')).toBe(2)
    expect(store.interactions.get('answered-old')).toBeNull()
    expect(store.interactions.get('closed-old')).toBeNull()
    expect(store.interactions.get('answered-new')).not.toBeNull()
    // An ask nobody answered is the one thing this table must not forget.
    expect(store.interactions.get('ancient-open')).not.toBeNull()
  } finally {
    store.close()
  }
})
