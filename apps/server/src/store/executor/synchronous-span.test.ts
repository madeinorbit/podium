/**
 * The synchronous span bridge [POD-3260].
 *
 * WHAT EACH TEST HAS TO AVOID, and it is the trap spec §6 rule 14 names: every
 * one of these could be written so that it passes with the bridge doing nothing.
 * A body that registers an effect and then returns will run that effect at some
 * point in any implementation, so "the effect ran" proves nothing. What proves
 * the mechanism is WHEN it ran RELATIVE to something else, so every test here
 * asserts an ORDER — against the commit, against a sibling batch, against the
 * body's own throw — and the one that cannot (the seam test) drives the
 * production entry point rather than a locally wrapped copy of it.
 */

import { openDatabase, type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../store'
import { PostCommitError, StoreUnhealthyError } from './errors'
import { postCommit } from './executor'
import {
  afterCommit,
  restoreSpanEffectSinks,
  type SpanEffectSinks,
  runSynchronousSpan,
  setSpanEffectSinks,
} from './synchronous-span'

let installed: SpanEffectSinks | undefined
const reported: string[] = []

/** Collect what the isolated mechanisms reported instead of throwing. */
function collectSinks(): void {
  installed = setSpanEffectSinks({
    markUnhealthy: (_error, label) => reported.push(`unhealthy:${label}`),
    effectSink: (_error, label) => reported.push(`effect:${label}`),
    onReportFailure: (_error, label) => reported.push(`report:${label}`),
  })
}

afterEach(() => {
  if (installed) restoreSpanEffectSinks(installed)
  installed = undefined
  reported.length = 0
})

describe('runSynchronousSpan', () => {
  it('runs registered work after the body returns, not where it was registered', () => {
    const order: string[] = []
    runSynchronousSpan(() => {
      postCommit().effect(() => void order.push('effect'), 'e')
      order.push('body-line-after-register')
    })
    expect(order).toEqual(['body-line-after-register', 'effect'])
  })

  it('runs the drain after COMMIT, not merely after the callback', () => {
    // The distinction the whole issue turns on. `transaction(db, fn)` issues the
    // COMMIT after fn returns, so a drain that ran at the end of the body would
    // still be inside the open transaction. A second connection is what can tell
    // the two apart: it cannot see the row until the commit lands.
    const db = openDatabase(':memory:')
    try {
      db.exec('CREATE TABLE probe (v INTEGER)')
      const openWhen: boolean[] = []
      runSynchronousSpan(() =>
        transaction(db, () => {
          db.prepare('INSERT INTO probe VALUES (?)').run(1)
          openWhen.push(inTransaction(db))
          postCommit().effect(() => void openWhen.push(inTransaction(db)), 'e')
        }),
      )
      // Inside the body the transaction is open; by the time the effect runs it
      // is not. A drain at the end of the callback would report [true, true].
      expect(openWhen).toEqual([true, false])
    } finally {
      db.close()
    }
  })

  it('discards everything a body that threw registered', () => {
    const ran: string[] = []
    expect(() =>
      runSynchronousSpan(() => {
        postCommit().effect(() => void ran.push('effect'), 'e')
        postCommit().followUp(() => void ran.push('follow-up'), 'f')
        postCommit().applyCommit(() => void ran.push('apply'), 'a')
        throw new Error('body failed')
      }),
    ).toThrow('body failed')
    expect(ran).toEqual([])
  })

  it('drains in mechanism order: commit applications, then follow-ups, then effects', () => {
    const order: string[] = []
    runSynchronousSpan(() => {
      postCommit().effect(() => void order.push('effect'), 'e')
      postCommit().followUp(() => void order.push('follow-up'), 'f')
      postCommit().applyCommit(() => void order.push('apply'), 'a')
    })
    expect(order).toEqual(['apply', 'follow-up', 'effect'])
  })
})

describe('a nested span is a savepoint, not a commit', () => {
  it('holds the inner registrations until the OUTER span commits', () => {
    const order: string[] = []
    runSynchronousSpan(() => {
      runSynchronousSpan(() => {
        postCommit().effect(() => void order.push('inner-effect'), 'inner')
      })
      // If the inner span had drained on its own release, the effect would
      // already be in `order` here — and it would have run inside the still-open
      // outer transaction, which is the defect this whole issue is about.
      order.push('outer-body-after-inner')
    })
    expect(order).toEqual(['outer-body-after-inner', 'inner-effect'])
  })

  it('discards the inner registrations when the inner span throws, and keeps the outer ones', () => {
    const ran: string[] = []
    runSynchronousSpan(() => {
      try {
        runSynchronousSpan(() => {
          postCommit().effect(() => void ran.push('inner'), 'inner')
          throw new Error('savepoint rolled back')
        })
      } catch {
        /* the outer body handles it and carries on, as a caller may */
      }
      postCommit().effect(() => void ran.push('outer'), 'outer')
    })
    expect(ran).toEqual(['outer'])
  })
})

describe('the failure contracts', () => {
  it('reports a follow-up failure as committed, distinguishably from a body failure', () => {
    // The coordinator's addition (POD-3221 mail, 2026-09-03): a follow-up runs
    // AFTER the commit, so its failure must never reach the caller looking like
    // a rollback. The assertion is on the CLASS and on `committed`, not on the
    // message, because a caller decides whether to retry on exactly that.
    let caught: unknown
    try {
      runSynchronousSpan(() => {
        postCommit().followUp(() => {
          throw new Error('mail row rejected')
        }, 'mail')
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PostCommitError)
    expect((caught as PostCommitError).committed).toBe(true)
    expect((caught as PostCommitError).mechanism).toBe('follow-up')
    expect((caught as PostCommitError).cause).toBeInstanceOf(Error)

    // And the other arm, which is what makes the first one mean anything: a
    // failure of the BODY is the body's own error, carries no `committed`, and
    // is not one of the post-commit classes.
    let fromBody: unknown
    try {
      runSynchronousSpan(() => {
        throw new Error('body failed')
      })
    } catch (error) {
      fromBody = error
    }
    expect(fromBody).not.toBeInstanceOf(PostCommitError)
    expect(fromBody).not.toBeInstanceOf(StoreUnhealthyError)
    expect((fromBody as Error).message).toBe('body failed')
  })

  it('keeps draining after a follow-up failure and reports the FIRST one', () => {
    const ran: string[] = []
    let caught: unknown
    try {
      runSynchronousSpan(() => {
        postCommit().followUp(() => {
          throw new Error('first')
        }, 'one')
        postCommit().followUp(() => {
          ran.push('two')
          throw new Error('second')
        }, 'two')
        postCommit().effect(() => void ran.push('effect'), 'e')
      })
    } catch (error) {
      caught = error
    }
    // The later steps still ran: a batch that stopped at the first failure would
    // leave the rest of its subscribers permanently behind.
    expect(ran).toEqual(['two', 'effect'])
    expect((caught as PostCommitError).cause).toMatchObject({ message: 'first' })
  })

  it('stops the drain on a commit-application failure and marks the store unhealthy', () => {
    collectSinks()
    const ran: string[] = []
    let caught: unknown
    try {
      runSynchronousSpan(() => {
        postCommit().applyCommit(() => {
          throw new Error('baseline fold failed')
        }, 'fold')
        postCommit().followUp(() => void ran.push('follow-up'), 'f')
        postCommit().effect(() => void ran.push('effect'), 'e')
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StoreUnhealthyError)
    expect((caught as StoreUnhealthyError).committed).toBe(true)
    expect(reported).toEqual(['unhealthy:fold'])
    // Mechanism 1 is not skippable and not recoverable: nothing behind it runs,
    // because the projection is already known to disagree with the database.
    expect(ran).toEqual([])
  })

  it('isolates an effect failure and reports it instead of throwing', () => {
    collectSinks()
    const ran: string[] = []
    expect(() =>
      runSynchronousSpan(() => {
        postCommit().effect(() => {
          throw new Error('socket closed')
        }, 'socket')
        postCommit().effect(() => void ran.push('second'), 'second')
      }),
    ).not.toThrow()
    expect(ran).toEqual(['second'])
    expect(reported).toEqual(['effect:socket'])
  })

  it('routes a rejected asynchronous effect to the sink rather than to an unhandled rejection', async () => {
    collectSinks()
    runSynchronousSpan(() => {
      postCommit().effect(() => Promise.reject(new Error('notify failed')), 'notify')
    })
    // Nobody waits for an effect, so the rejection lands a turn later.
    await Promise.resolve()
    await Promise.resolve()
    expect(reported).toEqual(['effect:notify'])
  })

  it('refuses an asynchronous follow-up rather than letting it settle unwatched', () => {
    let caught: unknown
    try {
      runSynchronousSpan(() => {
        postCommit().followUp(async () => {
          await Promise.resolve()
        }, 'async-follow-up')
      })
    } catch (error) {
      caught = error
    }
    // Refused, not dropped: with a synchronous drain there is nobody to await
    // it, so the caller would be told the durable work was done before it ran.
    expect((caught as PostCommitError).cause).toBeInstanceOf(TypeError)
    expect(String((caught as PostCommitError).cause)).toContain('thenable')
  })

  it('does not let a throwing report sink become the transaction’s error', () => {
    installed = setSpanEffectSinks({
      effectSink: () => {
        throw new Error('the logger is broken')
      },
      onReportFailure: (_error, label) => reported.push(`report:${label}`),
    })
    expect(() =>
      runSynchronousSpan(() => {
        postCommit().effect(() => {
          throw new Error('socket closed')
        }, 'socket')
      }),
    ).not.toThrow()
    expect(reported).toEqual(['report:socket'])
  })
})

describe('a follow-up that commits re-entrantly', () => {
  it('delivers batch N to every step before N+1, through the queue rather than recursion', () => {
    // The same rule, and the same reason, as `PostCommitRunner.drain`'s queue: a
    // plain recursive call delivers N+1 in the middle of N and hands delta
    // clients a permanent gap. Two "subscribers" make the interleaving visible;
    // one would pass under either implementation.
    const delivered: string[] = []
    const deliver = (batch: number, andCommitAgain: boolean): void => {
      for (const name of ['A', 'B']) {
        runSynchronousSpan(() => {
          postCommit().followUp(() => {
            delivered.push(`${name}:${batch}`)
            if (andCommitAgain && name === 'A') deliver(batch + 1, false)
          }, `${name}:${batch}`)
        })
      }
    }
    runSynchronousSpan(() => {
      postCommit().followUp(() => deliver(1, true), 'open')
    })
    // A:1 commits batch 2 from inside its own delivery. Batch 2 must not reach
    // A before batch 1 has reached B.
    expect(delivered).toEqual(['A:1', 'B:1', 'A:2', 'B:2'])
  })

  it('still finishes the re-entrant work before the outer call returns', () => {
    // Because the drain is synchronous, "queued behind the current batch" does
    // not mean "later than the caller": everything is done by the time
    // `runSynchronousSpan` returns, which is what keeps durable mail durable by
    // the time `LockService.steal` hands its result back.
    const done: string[] = []
    runSynchronousSpan(() => {
      postCommit().followUp(() => {
        runSynchronousSpan(() => {
          postCommit().followUp(() => void done.push('nested'), 'nested')
        })
      }, 'outer')
    })
    expect(done).toEqual(['nested'])
  })
})

describe('afterCommit outside a span', () => {
  it('runs the step now, and unguarded', () => {
    collectSinks()
    const ran: string[] = []
    afterCommit(() => void ran.push('now'), 'x')
    expect(ran).toEqual(['now'])
    // Deliberately NOT isolated: there is no commit to protect out here, and
    // catching would hide a wiring fault behind a pane that never updates.
    expect(() =>
      afterCommit(() => {
        throw new Error('listener not wired')
      }, 'y'),
    ).toThrow('listener not wired')
    expect(reported).toEqual([])
  })
})

describe('the store seam', () => {
  it('opens a post-commit scope for every SessionStore.transact body', () => {
    // THE SEAM TEST, and the reason it drives `store.transact` rather than
    // wrapping `transaction` itself: every other test in this file would pass
    // with the production store never wired to the bridge at all. This one is
    // the only thing that says the scope reaches a real span body.
    const store = new SessionStore(':memory:')
    try {
      const order: string[] = []
      store.transact(() => {
        postCommit().effect(() => void order.push('effect'), 'e')
        order.push('body')
      })
      expect(order).toEqual(['body', 'effect'])
    } finally {
      store.close()
    }
  })

  it('drops the registered work when the transact body throws', () => {
    const store = new SessionStore(':memory:')
    try {
      const ran: string[] = []
      expect(() =>
        store.transact(() => {
          postCommit().effect(() => void ran.push('effect'), 'e')
          throw new Error('rolled back')
        }),
      ).toThrow('rolled back')
      expect(ran).toEqual([])
    } finally {
      store.close()
    }
  })
})

/** Is a transaction open on this connection? */
function inTransaction(db: SqlDatabase): boolean {
  // A second BEGIN throws "cannot start a transaction within a transaction";
  // asking the engine is the only answer that cannot be faked by bookkeeping.
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch {
    return true
  }
  db.exec('ROLLBACK')
  return false
}
