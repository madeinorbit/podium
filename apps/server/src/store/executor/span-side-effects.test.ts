/**
 * The two harness shapes from POD-3248, with the REAL services wired [POD-3260].
 *
 * `executor.test.ts` proves the subscriber-inside-notification and
 * follow-up-rejection contracts against the executor's own fakes. This file
 * proves them where B0.5 has to hold them: over a real `SessionStore`, a real
 * `Ledger` and its real `Authority`, wired exactly as `relay.ts` wires them —
 * `transact` to the store and `postCommit` to the bridge. A contract that held
 * only for the fakes would be a contract this epic had not actually adopted.
 *
 * THE DEFECT EVERY TEST HERE IS ABOUT, stated once. A commit that is NESTED
 * inside a caller's wider span used to publish at its own savepoint release.
 * `IssueAttachOrchestrator.execute` wraps a whole attach in one
 * `SessionStore.transact` and every `ledger.commit` under it is a savepoint, so
 * subscribers were told about changes the outer body could still roll back —
 * and the change rows themselves DID roll back, leaving the feed ahead of the
 * log with no way to notice.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Ledger } from '@podium/sync'
import { SessionStore } from '../../store'
import { PostCommitError } from './errors'
import { postCommit } from './executor'
import { afterCommit } from './synchronous-span'

const stores: SessionStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

/** A store and a Ledger over it, wired the way `relay.ts` wires them. */
function openWiredStore(): { store: SessionStore; ledger: Ledger } {
  const store = new SessionStore(':memory:')
  stores.push(store)
  const ledger = new Ledger({
    repo: store.sync,
    now: () => Date.now(),
    transact: (fn) => store.transact(fn),
    postCommit: (step, label) => afterCommit(step, label),
  })
  return { store, ledger }
}

const upsert = (id: string, value: unknown) =>
  [{ entity: 'issue' as const, id, op: 'upsert' as const, value }] as const

describe('a nested ledger.commit publishes after the OUTER commit', () => {
  it('does not deliver while the enclosing transaction is still open', () => {
    const { store, ledger } = openWiredStore()
    const delivered: string[] = []
    ledger.onAppended((changes) => {
      for (const change of changes) delivered.push(change.id)
    })

    store.transact(() => {
      ledger.commit({ write: () => 'ok', changes: () => [...upsert('i1', { v: 1 })] })
      // The assertion that matters, and it is INSIDE the span: the savepoint has
      // released and the subscriber must still not have heard about it.
      expect(delivered).toEqual([])
    })
    expect(delivered).toEqual(['i1'])
  })

  it('tells nobody about changes the outer body rolled back', () => {
    const { store, ledger } = openWiredStore()
    const delivered: string[] = []
    ledger.onAppended((changes) => {
      for (const change of changes) delivered.push(change.id)
    })

    expect(() =>
      store.transact(() => {
        ledger.commit({ write: () => 'ok', changes: () => [...upsert('i2', { v: 1 })] })
        throw new Error('the attach failed after the nested commit')
      }),
    ).toThrow('the attach failed after the nested commit')

    // The change row went with the rollback, so a delivery would have described
    // a row the durable log does not have. Both halves are asserted, because
    // "nothing was delivered" alone would also be true if nothing had committed
    // in the first place.
    expect(delivered).toEqual([])
    expect(store.sync.maxChangeSeq()).toBe(0)
  })

  it('still delivers immediately when the commit is the whole transaction', () => {
    // The other arm, and the one that says the change is a MOVE rather than a
    // deferral: with no enclosing span, delivery happens where it always did.
    const { ledger } = openWiredStore()
    const delivered: string[] = []
    ledger.onAppended((changes) => {
      for (const change of changes) delivered.push(change.id)
    })
    ledger.commit({ write: () => 'ok', changes: () => [...upsert('i3', { v: 1 })] })
    expect(delivered).toEqual(['i3'])
  })
})

describe('a subscriber that commits from inside its own notification', () => {
  it('delivers batch N to every subscriber before N+1', () => {
    // POD-3248's subscriber-inside-notification case, over the real Authority.
    // Two subscribers make the interleaving visible; with one, a recursive
    // delivery and an ordered one are indistinguishable.
    const { store, ledger } = openWiredStore()
    const seen: string[] = []
    let reentered = false
    for (const name of ['A', 'B']) {
      ledger.onAppended((changes) => {
        for (const change of changes) seen.push(`${name}:${change.id}`)
        if (name === 'A' && !reentered) {
          reentered = true
          ledger.commit({ write: () => 'ok', changes: () => [...upsert('second', { v: 1 })] })
        }
      })
    }

    store.transact(() => {
      ledger.commit({ write: () => 'ok', changes: () => [...upsert('first', { v: 1 })] })
    })

    // A's re-entrant commit must not reach A before batch 1 reached B.
    expect(seen).toEqual(['A:first', 'B:first', 'A:second', 'B:second'])
    // And both rows are durable, so the re-entrant commit really committed
    // rather than being swallowed by the ordering.
    expect(store.sync.maxChangeSeq()).toBe(2)
  })
})

describe('a durable follow-up that rejects', () => {
  it('never reads as a rollback: the write is committed and the error says so', () => {
    // POD-3248's follow-up-rejection case. The write under test is a REAL change
    // append through the real Ledger, so "committed" is a claim the database can
    // be asked about rather than a flag the test set itself.
    const { store, ledger } = openWiredStore()
    let caught: unknown
    try {
      store.transact(() => {
        ledger.commit({ write: () => 'ok', changes: () => [...upsert('i4', { v: 1 })] })
        postCommit().followUp(() => {
          throw new Error('the derived row could not be written')
        }, 'derived-row')
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(PostCommitError)
    expect((caught as PostCommitError).committed).toBe(true)
    // THE POINT: a caller that read the rejection as a rollback and retried
    // would append the change twice. The row is there.
    expect(store.sync.maxChangeSeq()).toBe(1)
  })
})

describe('the event log announces after the commit', () => {
  it('holds the feed announcement until the enclosing span commits', () => {
    const { store } = openWiredStore()
    const announced: string[] = []
    store.events.onAppend((_id, event) => announced.push(event.kind))

    store.transact(() => {
      store.events.appendEvent({
        ts: new Date().toISOString(),
        kind: 'lock.stolen',
        subject: 'repo:merge',
      })
      // `LockService.steal` appends exactly here, inside its lock transaction.
      expect(announced).toEqual([])
    })
    expect(announced).toEqual(['lock.stolen'])
  })

  it('announces nothing for an append the span rolled back', () => {
    const { store } = openWiredStore()
    const announced: string[] = []
    store.events.onAppend((_id, event) => announced.push(event.kind))

    expect(() =>
      store.transact(() => {
        store.events.appendEvent({
          ts: new Date().toISOString(),
          kind: 'lock.stolen',
          subject: 'repo:merge',
        })
        throw new Error('the lock transaction failed')
      }),
    ).toThrow('the lock transaction failed')
    expect(announced).toEqual([])
    expect(store.events.maxEventId()).toBe(0)
  })

  it('announces immediately outside a span, exactly where it did before', () => {
    const { store } = openWiredStore()
    const announced: string[] = []
    store.events.onAppend((_id, event) => announced.push(event.kind))
    store.events.appendEvent({
      ts: new Date().toISOString(),
      kind: 'session.exited',
      subject: 'ses_1',
    })
    expect(announced).toEqual(['session.exited'])
  })
})
