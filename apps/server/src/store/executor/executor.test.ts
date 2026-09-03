/**
 * THE QUEUE IS PROVEN, NOT ASSUMED [POD-3248, spec §5.1].
 *
 * Everything the scheduler exists for is a statement about what cannot happen
 * BETWEEN two awaits, and a test that never parks a body inside its transaction
 * cannot see any of it. So every test here drives the interleaving by hand: the
 * bodies wait on barriers, the test releases them in the order it wants, and the
 * driver's statement log is the oracle for the boundaries that results alone
 * cannot show — two transactions that interleave still return the right rows
 * most of the time.
 *
 * Each test names the failure it would catch, because "the scheduler works" is
 * not a property and a green suite of happy paths would say exactly that.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { DriverSession, QueryClient, Statement, StoreDriver } from './driver'
import { NO_BUSY_RETRY, queryClientOver, UNBOUNDED_WRITE_BUDGET_MS } from './driver'
import {
  AbandonedNestedTransactionError,
  ExclusiveInsideLeaseError,
  ParallelNestedTransactionError,
  PostCommitError,
  SchedulerClosedError,
  StaleTransactionError,
  StoreUnhealthyError,
  TransactionPoisonedError,
} from './errors'
import { createStoreExecutor, postCommit, type StoreExecutor } from './executor'
import { createFrameFlusher } from './frame-flusher'
import { asyncFakeDriver, barrier, type Harness, openHarness, settle } from './harness'
import { createScheduler } from './scheduler'

let harness: Harness | undefined

function open(options: Parameters<typeof openHarness>[0] = {}): Harness {
  harness = openHarness(options)
  return harness
}

afterEach(async () => {
  const current = harness
  harness = undefined
  await current?.close()
})

const insert = 'INSERT INTO notes (body) VALUES (?)'
const bodies = 'SELECT body FROM notes ORDER BY id'

async function noteBodies(client: { all: (sql: string) => Promise<unknown[]> }): Promise<string[]> {
  const rows = (await client.all(bodies)) as { body: string }[]
  return rows.map((row) => row.body)
}

/**
 * Every transaction boundary in the log, checked for nesting. A second
 * `BEGIN IMMEDIATE` before the first one's `COMMIT` is the failure the size-one
 * queue exists to prevent, and it is invisible in query results.
 */
function assertNoInterleavedTransactions(entries: readonly string[]): void {
  let openSession: string | undefined
  for (const entry of entries) {
    const [session, ...rest] = entry.split(':')
    const statement = rest.join(':')
    if (statement === 'BEGIN IMMEDIATE') {
      expect(openSession, `a second BEGIN while ${openSession} was open`).toBeUndefined()
      openSession = session
      continue
    }
    if (statement === 'COMMIT' || statement === 'ROLLBACK') {
      expect(session).toBe(openSession)
      openSession = undefined
    }
  }
  expect(openSession).toBeUndefined()
}

describe('serialisation', () => {
  it('runs one write body at a time, in call order, and never opens a second BEGIN', async () => {
    // WOULD CATCH: a queue that admits the next body while the first is parked
    // on an await — the exact regression that turns "one writer" into two open
    // transactions on one connection.
    const h = open()
    const order: string[] = []
    const parked = barrier()

    const first = h.executor.transact(async (tx) => {
      order.push('first:start')
      await parked.wait()
      await tx.drizzle.run(insert, 'first')
      order.push('first:end')
    })
    const second = h.executor.transact(async (tx) => {
      order.push('second:start')
      await tx.drizzle.run(insert, 'second')
      order.push('second:end')
    })

    await parked.reached()
    await settle()
    expect(order).toEqual(['first:start'])

    parked.release()
    await Promise.all([first, second])

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
    expect(await noteBodies(h.db)).toEqual(['first', 'second'])
    assertNoInterleavedTransactions(h.log.entries)
  })

  it('serialises a burst of writers started in one turn', async () => {
    const h = open()
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.executor.transact(async (tx) => {
          // An await INSIDE the body: without the queue this is where the next
          // body would slip in.
          await settle(2)
          await tx.drizzle.run(insert, `w${i}`)
        }),
      ),
    )
    expect(await noteBodies(h.db)).toEqual(Array.from({ length: 8 }, (_, i) => `w${i}`))
    assertNoInterleavedTransactions(h.log.entries)
  })
})

describe('rollback isolation', () => {
  it('rolls back the body’s writes and rethrows the original error', async () => {
    const h = open()
    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'kept')
    })
    await expect(
      h.executor.transact(async (tx) => {
        await tx.drizzle.run(insert, 'discarded')
        throw new Error('body failed')
      }),
    ).rejects.toThrow('body failed')

    expect(await noteBodies(h.db)).toEqual(['kept'])
    expect(h.log.entries).toContain('s2:ROLLBACK')
  })
})

describe('reads against an open body', () => {
  it('does not let a root read observe a body’s uncommitted rows', async () => {
    // WOULD CATCH: a read lane that runs concurrently on the write connection.
    // On one connection an uncommitted row IS visible, so nothing but the queue
    // stops the read from returning it.
    const h = open()
    const parked = barrier()
    const observed: string[][] = []

    const write = h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'uncommitted')
      await parked.wait()
    })
    const read = h.executor.read(async (tx) => {
      observed.push(await noteBodies(tx.drizzle))
    })

    await parked.reached()
    await settle()
    expect(observed, 'the read must still be queued behind the open body').toEqual([])

    parked.release()
    await Promise.all([write, read])
    expect(observed).toEqual([['uncommitted']])
  })

  it('gives outsideTransaction the committed view from inside an open body', async () => {
    // The one deliberate committed-view read. It must NOT see the body's own
    // writes: that is the whole reason it exists, and a version that queued on
    // the write lane would simply deadlock.
    const h = open()
    let seenOutside: string[] | undefined
    let seenInside: string[] | undefined

    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'in-flight')
      seenInside = await noteBodies(tx.drizzle)
      await h.executor.outsideTransaction(async (view) => {
        seenOutside = await noteBodies(view.drizzle)
      })
    })

    expect(seenInside).toEqual(['in-flight'])
    expect(seenOutside).toEqual([])
    expect(await noteBodies(h.db)).toEqual(['in-flight'])
  })

  it('refuses the committed-view read when the driver has no reader connection', async () => {
    const h = open({ withoutReader: true })
    await expect(
      h.executor.transact(async () => {
        await h.executor.outsideTransaction(async () => undefined)
      }),
    ).rejects.toThrow(/no reader connection/)
  })
})

describe('the prepared-statement cache', () => {
  it('prepares each SQL text once per connection, across leases', async () => {
    // WOULD CATCH the cache being owned by the LEASE: `session()` is built fresh
    // for every scheduler operation over the same connection, so a cache created
    // inside it re-prepares every statement on every root call — the opposite of
    // the claim, and a local regression once repository calls become async.
    const prepared: string[] = []
    const h = open({ onPrepare: (sql) => prepared.push(sql) })

    for (let i = 0; i < 3; i++) {
      await h.executor.transact(async (tx) => {
        await tx.drizzle.run(insert, `row-${i}`)
      })
      await noteBodies(h.db)
    }

    expect(
      prepared.filter((sql) => sql === insert),
      'three writes, one prepare',
    ).toHaveLength(1)
    expect(
      prepared.filter((sql) => sql === bodies),
      'three reads, one prepare',
    ).toHaveLength(1)
  })
})

describe('re-entrancy', () => {
  it('turns a nested transact into a savepoint on the open transaction', async () => {
    // WOULD CATCH: re-entrancy keyed on handle identity (today's helper) rather
    // than on the caller's scope. Keyed on the handle, a nested call from a
    // DIFFERENT body would also see depth > 0 and silently join a transaction
    // it has nothing to do with.
    const h = open()
    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'outer')
      await tx.transact(async (inner) => {
        await inner.drizzle.run(insert, 'inner')
      })
    })

    expect(await noteBodies(h.db)).toEqual(['outer', 'inner'])
    expect(h.log.boundaries()).toEqual([
      's1:BEGIN IMMEDIATE',
      's1:SAVEPOINT podium_sp_1',
      's1:RELEASE podium_sp_1',
      's1:COMMIT',
    ])
  })

  it('rolls the savepoint back without losing the outer transaction', async () => {
    const h = open()
    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'outer')
      await expect(
        tx.transact(async (inner) => {
          await inner.drizzle.run(insert, 'inner')
          throw new Error('nested failed')
        }),
      ).rejects.toThrow('nested failed')
      await tx.drizzle.run(insert, 'after')
    })

    expect(await noteBodies(h.db)).toEqual(['outer', 'after'])
    expect(h.log.boundaries()).toContain('s1:ROLLBACK TO podium_sp_1')
    expect(h.log.boundaries()).toContain('s1:COMMIT')
  })

  it('refuses two nested scopes at once, and a parent statement under an open child', async () => {
    // Savepoints are a stack, not a tree: two branches would release each
    // other's boundaries.
    const h = open()
    const parked = barrier()

    await h.executor.transact(async (tx) => {
      // The nested scope is claimed in the caller's own turn, before its first
      // await, so a second branch opened in the same turn is refused rather
      // than racing for the savepoint stack.
      const branch = tx.transact(async () => {
        await parked.wait()
      })
      await expect(tx.transact(async () => undefined)).rejects.toBeInstanceOf(
        ParallelNestedTransactionError,
      )
      await expect(tx.drizzle.all(bodies)).rejects.toBeInstanceOf(ParallelNestedTransactionError)
      parked.release()
      await branch
      // Once the branch closes, the parent is addressable again.
      expect(await noteBodies(tx.drizzle)).toEqual([])
    })
  })
})

/**
 * Savepoint boundaries are infallible on bun:sqlite and are ordinary statements
 * on a network everywhere else, so every one of them can reject [POD-3310, V1
 * medium]. What the executor may not do is leave the frame stack claiming
 * something the engine does not hold.
 */
describe('asynchronous savepoint boundary failures', () => {
  it('gives the parent back its addressability when the savepoint never opened', async () => {
    const driver = asyncFakeDriver({
      hooks: {
        enterSavepoint: async () => {
          throw new Error('SAVEPOINT failed')
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })

    await executor.transact(async (tx) => {
      await expect(tx.transact(async () => undefined)).rejects.toThrow('SAVEPOINT failed')
      // WOULD CATCH `parent.child` left set by the failed entry: every later
      // statement on the parent would be refused as a parallel nested scope.
      await tx.drizzle.run(insert, 'after')
    })

    expect(driver.calls.filter((call) => call.endsWith(':commit'))).toEqual(['s1:commit'])
    await executor.close()
  })

  it('poisons the transaction when the release fails, and rolls back instead of committing', async () => {
    const driver = asyncFakeDriver({
      hooks: {
        releaseSavepoint: async () => {
          throw new Error('RELEASE failed')
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })

    const failure = await executor
      .transact(async (tx) => {
        await tx.drizzle.run(insert, 'outer')
        // The body catches the boundary failure and carries on, which is the
        // dangerous case: it must not be able to commit from here.
        await expect(tx.transact(async () => undefined)).rejects.toThrow('RELEASE failed')
        await expect(tx.drizzle.run(insert, 'after')).rejects.toBeInstanceOf(
          TransactionPoisonedError,
        )
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(TransactionPoisonedError)
    expect((failure as TransactionPoisonedError).cause).toBeInstanceOf(Error)
    expect(driver.calls.filter((call) => /:(commit|rollback)$/.test(call))).toEqual(['s1:rollback'])
    await executor.close()
  })

  it('poisons the transaction when a rollback-to-savepoint fails, and keeps the body’s error', async () => {
    const driver = asyncFakeDriver({
      hooks: {
        rollbackToSavepoint: async () => {
          throw new Error('ROLLBACK TO failed')
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })

    const failure = await executor
      .transact(async (tx) => {
        await expect(
          tx.transact(async () => {
            throw new Error('nested failed')
          }),
          // The body's own error is what the caller asked about; the boundary
          // failure is what decides the transaction's fate.
        ).rejects.toThrow('nested failed')
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(TransactionPoisonedError)
    expect(driver.calls.filter((call) => /:(commit|rollback)$/.test(call))).toEqual(['s1:rollback'])
    await executor.close()
  })
})

describe('the active transaction token', () => {
  it('rejects an operation that reaches the transaction after its scope ended', async () => {
    // "Nothing runs after its commit" is enforced by the TOKEN, not by the
    // callback boundary: a promise the body never awaited resolves later, and
    // would otherwise run its statement in autocommit.
    const h = open()
    let escaped: StoreExecutor<QueryClient> | undefined

    await h.executor.transact(async (tx) => {
      escaped = tx
      await tx.drizzle.run(insert, 'committed')
    })

    const stale = escaped as StoreExecutor<QueryClient>
    await expect(stale.drizzle.all(bodies)).rejects.toBeInstanceOf(StaleTransactionError)
    await expect(stale.transact(async () => undefined)).rejects.toBeInstanceOf(
      StaleTransactionError,
    )
    await expect(stale.read(async () => undefined)).rejects.toBeInstanceOf(StaleTransactionError)
    expect(await noteBodies(h.db)).toEqual(['committed'])
  })
})

describe('ambient routing', () => {
  it('routes a root-bound call into the open transaction, so a body reads its own writes', async () => {
    // This is what makes `store.x` usable from inside a body: a service holding
    // the ROOT executor's repositories must see the transaction's own writes,
    // or every cached aggregate rebuilt inside a span would be built from the
    // pre-commit state.
    const h = open()
    let ambient: string[] | undefined
    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'own-write')
      ambient = await noteBodies(h.db)
    })
    expect(ambient).toEqual(['own-write'])
    // One BEGIN: the ambient read joined the transaction rather than opening a
    // scope of its own.
    expect(h.log.boundaries()).toEqual(['s1:BEGIN IMMEDIATE', 's1:COMMIT'])
  })

  it('runs a root-bound call on the root when no transaction is open', async () => {
    const h = open()
    await h.db.run(insert, 'ambient')
    expect(await noteBodies(h.db)).toEqual(['ambient'])
  })
})

describe('the exclusive lane', () => {
  it('refuses an exclusive request from a lease holder', async () => {
    // It would wait for the lane it is already holding. A deadlock is a worse
    // answer than a refusal.
    const h = open()
    await expect(
      h.executor.transact(async () => {
        await h.executor.exclusive(async () => undefined)
      }),
    ).rejects.toBeInstanceOf(ExclusiveInsideLeaseError)
  })

  it('runs alone: queued work waits for it and it waits for work in flight', async () => {
    const h = open()
    const order: string[] = []
    const parked = barrier()

    const write = h.executor.transact(async () => {
      order.push('write:start')
      await parked.wait()
      order.push('write:end')
    })
    const exclusive = h.executor.exclusive(async () => {
      order.push('exclusive')
    })
    const after = h.executor.transact(async () => {
      order.push('after')
    })

    await parked.reached()
    await settle()
    expect(order).toEqual(['write:start'])
    parked.release()
    await Promise.all([write, exclusive, after])
    expect(order).toEqual(['write:start', 'write:end', 'exclusive', 'after'])
  })
})

/**
 * A driver with a CONCURRENT READ LANE, which bun:sqlite does not have. On one
 * connection `exclusive` and `write` are the same lane and no test can tell
 * them apart, so the lane policy the libsql implementation will use (E.5) is
 * pinned here instead: reads run concurrently, an exclusive request waits for
 * everything in flight, and nothing queued behind it overtakes it.
 */
function laneOnlyDriver(readConcurrency: number): StoreDriver<QueryClient> {
  const session: DriverSession = {
    execute: async () => ({ rows: [] }),
    executeBatch: async (statements) => statements.map(() => ({ rows: [] })),
    begin: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    enterSavepoint: async () => undefined,
    releaseSavepoint: async () => undefined,
    rollbackToSavepoint: async () => undefined,
    close: async () => undefined,
  }
  return {
    kind: 'lane-only',
    lanes: { readConcurrency },
    limits: { writeBudgetMs: UNBOUNDED_WRITE_BUDGET_MS, busyRetry: NO_BUSY_RETRY },
    open: async () => session,
    client: (route, routeBatch) => queryClientOver(route, routeBatch),
    close: async () => undefined,
  }
}

describe('the remote lane policy', () => {
  it('runs reads concurrently, drains before an exclusive, and lets nothing overtake it', async () => {
    const scheduler = createScheduler({ driver: laneOnlyDriver(3) })
    const parked = barrier()
    const order: string[] = []

    const reads = [0, 1, 2].map((i) =>
      scheduler.run('read', async () => {
        order.push(`read${i}:start`)
        await parked.wait()
        order.push(`read${i}:end`)
      }),
    )
    await settle()
    expect(order, 'three reads share the lane').toEqual([
      'read0:start',
      'read1:start',
      'read2:start',
    ])

    const exclusive = scheduler.run('exclusive', async () => {
      order.push('exclusive')
    })
    const behind = scheduler.run('read', async () => {
      order.push('behind')
    })
    await settle()
    expect(order, 'the exclusive waits, and the read behind it does not overtake').toEqual([
      'read0:start',
      'read1:start',
      'read2:start',
    ])

    parked.release()
    await Promise.all([...reads, exclusive, behind])
    expect(order.slice(-2)).toEqual(['exclusive', 'behind'])
    await scheduler.close()
  })
})

/**
 * The remote failures bun:sqlite cannot produce. `open` and `close` are network
 * calls there, so both can reject, and the scheduler's slot is what a rejection
 * must never take with it.
 */
describe('scheduler liveness under driver failure', () => {
  async function within<T>(promise: Promise<T>, ms = 100): Promise<T | 'blocked'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<'blocked'>((resolve) => {
      timer = setTimeout(() => resolve('blocked'), ms)
    })
    try {
      return await Promise.race([promise, guard])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  it('releases the slot when the driver’s open rejects', async () => {
    // WOULD CATCH the wedge V1 reproduced: `take()` happens before `open()`, so
    // a rejected connection acquisition — busy exhaustion, a network blip —
    // keeps the write slot forever while the state still reads `accepting`.
    const driver = asyncFakeDriver({
      hooks: {
        open: async (_lane, attempt) => {
          if (attempt === 1) throw new Error('open failed')
        },
      },
    })
    const scheduler = createScheduler({ driver })

    await expect(scheduler.run('write', async () => 'first')).rejects.toThrow('open failed')

    expect(await within(scheduler.run('write', async () => 'second'))).toBe('second')
    expect(scheduler.state).toBe('accepting')
    expect(await within(scheduler.close())).not.toBe('blocked')
  })

  it('releases the slot when the session’s close rejects', async () => {
    // The other end of the same lease. `close()` returns the connection; a
    // rejection there skipped `give()` and `pump()` exactly as `open` did.
    const driver = asyncFakeDriver({
      hooks: {
        close: async (attempt) => {
          if (attempt === 1) throw new Error('close failed')
        },
      },
    })
    const scheduler = createScheduler({ driver })

    await expect(scheduler.run('write', async () => 'first')).rejects.toThrow('close failed')

    expect(await within(scheduler.run('write', async () => 'second'))).toBe('second')
    expect(scheduler.state).toBe('accepting')
    expect(await within(scheduler.close())).not.toBe('blocked')
  })

  it('keeps both failures when the body and the close both fail', async () => {
    // Neither may be dropped: the body's failure is what the caller asked
    // about, and a connection that never came back is the driver's problem.
    const driver = asyncFakeDriver({
      hooks: {
        close: async (attempt) => {
          if (attempt === 1) throw new Error('close failed')
        },
      },
    })
    const scheduler = createScheduler({ driver })

    const failure = await scheduler
      .run('write', async () => {
        throw new Error('body failed')
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      'body failed',
      'close failed',
    ])
    expect(await within(scheduler.run('read', async () => 'after'))).toBe('after')
    await scheduler.close()
  })

  it('lets a queued waiter through when the holder’s open rejects', async () => {
    // The queued form of the same wedge: the second writer is already parked in
    // the FIFO when the first lease fails to acquire its connection.
    const parked = barrier()
    const driver = asyncFakeDriver({
      hooks: {
        open: async (_lane, attempt) => {
          if (attempt === 1) {
            await parked.wait()
            throw new Error('open failed')
          }
        },
      },
    })
    const scheduler = createScheduler({ driver })

    const first = scheduler.run('write', async () => 'first')
    const queued = scheduler.run('write', async () => 'queued')
    await parked.reached()
    await settle()
    parked.release()

    await expect(first).rejects.toThrow('open failed')
    expect(await within(queued)).toBe('queued')
    await scheduler.close()
  })
})

/**
 * THE CAPABILITIES THE REMOTE PATH IS LOAD-BEARING ON [POD-3310, V1 finding 3].
 *
 * The contract had one-statement routing and nothing else, so E.5 would have had
 * to change a supposedly-settled interface or reach around it. All three of
 * these are measured facts about Turso, not speculation: a batch is 42x
 * (POD-3251), the write transaction dies at about 9 s, and a concurrent writer
 * gets a busy shape that only a bounded retry above the transaction can answer.
 */
describe('the batch capability', () => {
  const run = (body: string): Statement => ({ sql: insert, params: [body], method: 'run' })

  it('reaches the driver as ONE call, on the open transaction', async () => {
    const h = open()
    await h.executor.transact(async (tx) => {
      await tx.drizzle.batch([run('a'), run('b'), run('c')])
    })

    // One entry, not three: a batch that resolved its scope per statement would
    // be three round trips again, and would lose its atomicity.
    expect(h.log.entries.filter((entry) => entry.includes('BATCH'))).toEqual(['s1:BATCH[3]'])
    expect(await noteBodies(h.db)).toEqual(['a', 'b', 'c'])
    expect(h.log.boundaries()).toEqual(['s1:BEGIN IMMEDIATE', 's1:COMMIT'])
  })

  it('routes a root batch ambiently, on the write lane, atomically', async () => {
    const h = open()
    // The second statement violates NOT NULL, so the batch fails as a unit.
    await expect(
      h.db.batch([run('kept'), { sql: insert, params: [null], method: 'run' }]),
    ).rejects.toThrow()
    expect(await noteBodies(h.db), 'all of it or none of it').toEqual([])

    await h.db.batch([run('a'), run('b')])
    expect(await noteBodies(h.db)).toEqual(['a', 'b'])
  })

  it('rolls a caught batch failure back inside an open transaction, prefix and all', async () => {
    // WOULD CATCH the batch that treats the ENCLOSING transaction as its
    // boundary: inside `transact` the statements ran in a bare loop, so a body
    // that CAUGHT the failure and carried on committed the prefix that had
    // already applied. "All of it applies or none of it does" is a property of
    // the batch, not of whatever transaction happens to be open around it.
    const h = open()
    await h.executor.transact(async (tx) => {
      await expect(
        tx.drizzle.batch([run('partial'), { sql: insert, params: [null], method: 'run' }]),
      ).rejects.toThrow()
      // The body catches and carries on, which is the whole point: the outer
      // rollback is not what makes the batch atomic.
      await tx.drizzle.run(insert, 'after')
      await tx.drizzle.batch([run('later')])
    })

    expect(await noteBodies(h.db), 'the caught batch left nothing behind').toEqual([
      'after',
      'later',
    ])
    // And it is still ONE driver call, with the transaction's own boundaries
    // unchanged: the batch's savepoint is the driver's business, not a frame.
    expect(h.log.entries.filter((entry) => entry.includes('BATCH'))).toEqual([
      's1:BATCH[2]',
      's1:BATCH[1]',
    ])
    expect(h.log.boundaries()).toEqual(['s1:BEGIN IMMEDIATE', 's1:COMMIT'])
  })

  it('refuses a root-bound ambient batch that resumes after the commit', async () => {
    // WOULD CATCH the ambient BATCH router losing its token check. The test
    // below leaks a TRANSACTION-bound handle, so it drives `frameBatchRouter`
    // and says nothing about the root client's transaction branch — which is
    // the branch a root-bound `store.drizzle.batch` inside a body takes, and
    // the one a mutation could empty while all 59 tests stayed green.
    const commitParked = barrier()
    const escaped = barrier()
    const driver = asyncFakeDriver({
      hooks: {
        commit: async () => {
          await commitParked.wait()
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })
    let leaked: Promise<unknown> | undefined

    const done = executor.transact(async (tx) => {
      // The ROOT client, resumed from the body's own context: the ambient
      // router's transaction branch, not the frame-bound one.
      leaked = escaped.wait().then(() => executor.drizzle.batch([run('late')]))
      await tx.drizzle.run(insert, 'body')
    })

    await commitParked.reached()
    escaped.release()
    await settle()
    await expect(leaked).rejects.toBeInstanceOf(StaleTransactionError)

    commitParked.release()
    await done

    // Never reached the session: a batch that ran during the commit would still
    // have returned results, so only the call log can say this.
    expect(driver.calls.filter((call) => call.includes(':batch['))).toEqual([])
    await executor.close()
  })

  it('refuses a batch on a transaction whose scope has ended', async () => {
    // The token rule is not per operation shape: a batch is as capable of
    // running after its commit as a statement is.
    const h = open()
    let escaped: StoreExecutor<QueryClient> | undefined
    await h.executor.transact(async (tx) => {
      escaped = tx
      await tx.drizzle.run(insert, 'committed')
    })
    await expect(
      (escaped as StoreExecutor<QueryClient>).drizzle.batch([run('late')]),
    ).rejects.toBeInstanceOf(StaleTransactionError)
    expect(await noteBodies(h.db)).toEqual(['committed'])
  })
})

describe('the declared write budget and busy retry', () => {
  const busy = new Error('SQLITE_BUSY: database is locked')
  const remoteLimits = {
    writeBudgetMs: 9_000,
    busyRetry: { attempts: 4, initialDelayMs: 10, maxDelayMs: 40 },
  }
  const classify = (error: unknown) => (error === busy ? ('busy' as const) : ('fatal' as const))

  it('refuses a watchdog budget at or above the driver’s hard limit', () => {
    // A watchdog above the engine's own limit can never fire first: it would
    // report a transaction the server has already killed.
    const driver = asyncFakeDriver({ limits: remoteLimits })
    expect(() =>
      createScheduler({ driver, watchdog: { budgetMs: 9_000, report: () => undefined } }),
    ).toThrow(/not below/)

    const ok = createScheduler({
      driver: asyncFakeDriver({ limits: remoteLimits }),
      watchdog: { budgetMs: 5_000, report: () => undefined },
    })
    expect(ok.state).toBe('accepting')
  })

  it('retries a busy BEGIN within the declared policy, and not a fatal one', async () => {
    let attempts = 0
    const driver = asyncFakeDriver({
      limits: remoteLimits,
      classify,
      hooks: {
        begin: async () => {
          if (++attempts < 3) throw busy
        },
      },
    })
    const slept: number[] = []
    const scheduler = createScheduler({ driver, sleep: async (ms) => void slept.push(ms) })

    const result = await scheduler.run('write', async (lease) => {
      await lease.begin('write')
      return 'committed'
    })

    expect(result).toBe('committed')
    expect(attempts).toBe(3)
    expect(slept, 'the declared backoff, doubling to its cap').toEqual([10, 20])
    await scheduler.close()
  })

  it('does not retry a failure the driver does not call busy', async () => {
    // A retry of work that may already have applied is worse than a failure, so
    // anything unclassified is fatal.
    let attempts = 0
    const driver = asyncFakeDriver({
      limits: remoteLimits,
      classify,
      hooks: {
        open: async () => {
          attempts++
          throw new Error('TRANSACTION_CLOSED')
        },
      },
    })
    const slept: number[] = []
    const scheduler = createScheduler({ driver, sleep: async (ms) => void slept.push(ms) })

    await expect(scheduler.run('write', async () => 'never')).rejects.toThrow('TRANSACTION_CLOSED')
    expect(attempts).toBe(1)
    expect(slept).toEqual([])
    await scheduler.close()
  })

  /**
   * THROUGH `createStoreExecutor`, NOT THROUGH A `Lease`.
   *
   * The three tests above build a scheduler and call `Lease.begin` themselves.
   * That proves the retry EXISTS; it cannot prove the executor uses it, and a
   * `transact` that called `lease.session.begin` instead would drop the
   * declared policy from every executor transaction with all of them still
   * green. Same for the implicit writes, which never pass through `begin` at
   * all. So these drive the production entry points and assert the exact
   * driver call sequence, which is the only place a retry is visible.
   */
  const write = (body: string): Statement => ({ sql: insert, params: [body], method: 'run' })

  it('opens the executor’s own transaction through the lease, so a busy BEGIN retries', async () => {
    let attempts = 0
    const driver = asyncFakeDriver({
      limits: remoteLimits,
      classify,
      hooks: {
        begin: async () => {
          if (++attempts < 3) throw busy
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })

    const result = await executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'body')
      return 'committed'
    })

    expect(result).toBe('committed')
    // Three BEGINs on ONE session, then the body: the retry is above the
    // transaction, so nothing of the body ran before the last attempt.
    expect(driver.calls).toEqual([
      'open:write',
      's1:begin:write',
      's1:begin:write',
      's1:begin:write',
      `s1:execute:${insert}`,
      's1:commit',
      's1:close',
    ])
    await executor.close()
  })

  it('retries a busy root autocommit write and a busy root batch, on the executor’s client', async () => {
    // An implicit atomic write takes the write lock inside the driver call, so
    // on Turso this is the COMMON busy path — and it never touches `begin`.
    // Retrying it is safe for exactly one reason: a busy classification is
    // raised at acquisition, before any of the unit applied, and the unit is
    // atomic, so a second attempt cannot double-apply a prefix.
    let statementAttempts = 0
    let batchAttempts = 0
    const driver = asyncFakeDriver({
      limits: remoteLimits,
      classify,
      hooks: {
        execute: async () => {
          if (++statementAttempts < 2) throw busy
        },
        executeBatch: async () => {
          if (++batchAttempts < 2) throw busy
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })

    await executor.drizzle.run(insert, 'root')
    await executor.drizzle.batch([write('a'), write('b')])

    expect(statementAttempts).toBe(2)
    expect(batchAttempts).toBe(2)
    expect(driver.calls).toEqual([
      'open:write',
      `s1:execute:${insert}`,
      `s1:execute:${insert}`,
      's1:close',
      'open:write',
      's2:batch[2]',
      's2:batch[2]',
      's2:close',
    ])
    await executor.close()
  })

  it('does not retry an implicit root write the driver calls fatal', async () => {
    // The bound matters as much as the retry: `TRANSACTION_CLOSED` and any
    // ambiguous post-application failure are attempted exactly once, because a
    // retry of work that may already have applied is worse than a failure.
    let attempts = 0
    const driver = asyncFakeDriver({
      limits: remoteLimits,
      classify,
      hooks: {
        executeBatch: async () => {
          attempts++
          throw new Error('TRANSACTION_CLOSED')
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })

    await expect(executor.drizzle.batch([write('a')])).rejects.toThrow('TRANSACTION_CLOSED')
    expect(attempts).toBe(1)
    expect(driver.calls).toEqual(['open:write', 's1:batch[1]', 's1:close'])
    await executor.close()
  })

  it('retries a busy acquisition, and stops at the declared deadline', async () => {
    let attempts = 0
    const driver = asyncFakeDriver({
      // A short budget with a long backoff: the attempt count would allow five
      // tries, the budget allows one retry.
      limits: {
        writeBudgetMs: 100,
        busyRetry: { attempts: 5, initialDelayMs: 80, maxDelayMs: 160 },
      },
      classify,
      hooks: {
        open: async () => {
          attempts++
          throw busy
        },
      },
    })
    let clock = 0
    const slept: number[] = []
    const scheduler = createScheduler({
      driver,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    })

    await expect(scheduler.run('write', async () => 'never')).rejects.toThrow(busy.message)
    // Waiting longer than the transaction could have lived buys nothing.
    expect(attempts).toBe(2)
    expect(slept).toEqual([80])
    expect(scheduler.state).toBe('accepting')
    await scheduler.close()
  })
})

describe('post-commit', () => {
  it('completes a subscriber-initiated durable commit before the outer await resolves, and delivers batch N to every subscriber before N+1', async () => {
    // THE BUG THIS SHAPE PREVENTS is the sync kernel's ordered-pipe bug moved
    // to the post-commit tail: a subscriber that commits re-entrantly from
    // inside the delivery of batch N would, under a recursive drain, get batch
    // N+1 to subscriber A before batch N ever reached subscriber B. Delta
    // clients apply `seq !== cursor + 1 -> heal`, so that reorder is a
    // permanent heal storm, not a cosmetic one.
    const h = open()
    const delivered: string[] = []
    const subscribers = ['A', 'B']

    const deliver = async (batch: number): Promise<void> => {
      for (const name of subscribers) {
        delivered.push(`${name}:${batch}`)
        if (name === 'A' && batch === 1) {
          // A projection writing a derived row: durable, re-entrant, and its
          // own publication must queue behind the batch being delivered.
          await h.executor.transact(async (tx) => {
            await tx.drizzle.run(insert, 'derived')
            postCommit().followUp(() => deliver(2), 'deliver:2')
          })
        }
      }
    }

    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'primary')
      postCommit().followUp(() => deliver(1), 'deliver:1')
    })

    expect(delivered).toEqual(['A:1', 'B:1', 'A:2', 'B:2'])
    // Durable before the outer await resolved: read on a fresh scope, after.
    expect(await noteBodies(h.db)).toEqual(['primary', 'derived'])
    // Two transactions on the same lease: the follow-up's commit is inside the
    // scheduler's ordered operation, so no other writer overtook publication.
    expect(h.log.boundaries()).toEqual([
      's1:BEGIN IMMEDIATE',
      's1:COMMIT',
      's1:BEGIN IMMEDIATE',
      's1:COMMIT',
    ])
  })

  it('marks the store unhealthy when a commit application fails, and says the write committed', async () => {
    const h = open()
    await expect(
      h.executor.transact(async (tx) => {
        await tx.drizzle.run(insert, 'committed')
        postCommit().applyCommit(() => {
          throw new Error('baseline fold failed')
        }, 'baseline')
      }),
    ).rejects.toBeInstanceOf(StoreUnhealthyError)

    // The row IS there: the rejection is not a rollback and must never be read
    // as one.
    expect(h.raw.prepare(bodies).all()).toEqual([{ body: 'committed' }])
    expect(h.executor.health.healthy).toBe(false)
    await expect(h.executor.read(async () => undefined)).rejects.toBeInstanceOf(StoreUnhealthyError)
  })

  it('marks a mechanism-1 failure committed, and a later refusal not committed', async () => {
    // WOULD CATCH the committed-error contract being wrong at exactly the point
    // it matters: a caller handling the rejection of a mechanism-1 failure can
    // otherwise not tell it from a rollback, and retrying it duplicates a
    // durable write (spec §3.3, rule 7).
    const h = open()
    const failure = await h.executor
      .transact(async (tx) => {
        await tx.drizzle.run(insert, 'committed')
        postCommit().applyCommit(() => {
          throw new Error('baseline fold failed')
        }, 'baseline')
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(StoreUnhealthyError)
    expect((failure as StoreUnhealthyError).committed).toBe(true)
    expect(h.raw.prepare(bodies).all()).toEqual([{ body: 'committed' }])

    // The REFUSAL afterwards is the opposite case and must say so: the store is
    // unhealthy, the work never ran, and nothing committed.
    const refusal = await h.executor
      .read(async () => undefined)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(refusal).toBeInstanceOf(StoreUnhealthyError)
    expect((refusal as StoreUnhealthyError).committed).toBe(false)
  })

  it('keeps a throwing effect sink out of the caller’s promise', async () => {
    // WOULD CATCH a logging or telemetry adapter turning an ISOLATED effect
    // failure into the transaction's rejection — and an unmarked one, so the
    // caller reads a committed write as a failed one.
    const lastResort: string[] = []
    const h = open({
      effectSink: () => {
        throw new Error('sink failed')
      },
      onReportFailure: (_error, label) => lastResort.push(label),
    })
    const ran: string[] = []

    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'committed')
      postCommit().effect(() => {
        throw new Error('socket gone')
      }, 'sync-effect')
      postCommit().effect(async () => {
        throw new Error('notify gone')
      }, 'async-effect')
      postCommit().effect(() => {
        ran.push('later')
      }, 'later')
    })

    await h.executor.effectsSettled()
    expect(lastResort, 'both the sync throw and the rejected promise').toEqual([
      'sync-effect',
      'async-effect',
    ])
    expect(ran, 'the effect after the failing ones still ran').toEqual(['later'])
    expect(await noteBodies(h.db)).toEqual(['committed'])
  })

  it('keeps a throwing unhealthy reporter from replacing the committed error', async () => {
    const lastResort: string[] = []
    const h = open({
      onUnhealthy: () => {
        throw new Error('logger failed')
      },
      onReportFailure: (_error, label) => lastResort.push(label),
    })

    const failure = await h.executor
      .transact(async (tx) => {
        await tx.drizzle.run(insert, 'committed')
        postCommit().applyCommit(() => {
          throw new Error('baseline fold failed')
        }, 'baseline')
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    // The reporter's own failure must not become the caller's error: that would
    // lose both the mechanism and the committed marker.
    expect(failure).toBeInstanceOf(StoreUnhealthyError)
    expect((failure as StoreUnhealthyError).committed).toBe(true)
    expect(lastResort).toEqual(['baseline'])
    expect(h.executor.health.healthy).toBe(false)
  })

  it('reports a durable follow-up failure as a committed failure and still drains the rest', async () => {
    const h = open()
    const ran: string[] = []
    const failure = await h.executor
      .transact(async (tx) => {
        await tx.drizzle.run(insert, 'committed')
        postCommit().followUp(() => {
          ran.push('first')
          throw new Error('mail failed')
        }, 'mail')
        postCommit().followUp(() => {
          ran.push('second')
        }, 'nudge')
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toBeInstanceOf(PostCommitError)
    expect((failure as PostCommitError).committed).toBe(true)
    expect(ran).toEqual(['first', 'second'])
    expect(h.executor.health.healthy).toBe(true)
    expect(await noteBodies(h.db)).toEqual(['committed'])
  })

  it('isolates an external effect: it is reported, not rethrown, and the next effect still runs', async () => {
    const reported: string[] = []
    const h = open({ effectSink: (_error, label) => reported.push(label) })
    const ran: string[] = []

    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'committed')
      postCommit().effect(() => {
        throw new Error('socket gone')
      }, 'broadcast')
      postCommit().effect(async () => {
        ran.push('notify')
      }, 'notify')
    })

    await h.executor.effectsSettled()
    expect(reported).toEqual(['broadcast'])
    expect(ran).toEqual(['notify'])
  })

  it('discards a rolled-back savepoint’s post-commit work and keeps the parent’s', async () => {
    // A savepoint release is not a commit: its tail belongs to whoever commits,
    // and a rolled-back branch must publish nothing.
    const h = open()
    const ran: string[] = []
    await h.executor.transact(async (tx) => {
      postCommit().applyCommit(() => {
        ran.push('outer')
      }, 'outer')
      await expect(
        tx.transact(async () => {
          postCommit().applyCommit(() => {
            ran.push('inner')
          }, 'inner')
          throw new Error('branch failed')
        }),
      ).rejects.toThrow('branch failed')
      await tx.transact(async () => {
        postCommit().applyCommit(() => {
          ran.push('kept')
        }, 'kept')
      })
      expect(ran, 'nothing runs before the commit').toEqual([])
    })
    expect(ran).toEqual(['outer', 'kept'])
  })
})

/**
 * THE TIMING THE TOKEN ACTUALLY CLAIMS [POD-3310, V1 finding 5].
 *
 * The landed harness proved the token only AFTER the outer promise resolved, so
 * two mutations survived all 36 tests: moving `closeFrame(frame)` to after
 * `await session.commit()`, and removing `assertAddressable(scope.frame)` only
 * from the ambient router's transaction branch. Both need a commit that PARKS —
 * a gap bun:sqlite's synchronous COMMIT does not have — and unawaited work
 * issued from the body's own context while it is parked.
 */
describe('the token during an asynchronous commit', () => {
  it('refuses the body’s unawaited work while the commit is parked', async () => {
    const commitParked = barrier()
    const escaped = barrier()
    const driver = asyncFakeDriver({
      hooks: {
        commit: async () => {
          await commitParked.wait()
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })
    let leakedExplicit: Promise<unknown> | undefined
    let leakedAmbient: Promise<unknown> | undefined

    const done = executor.transact(async (tx) => {
      // Neither is awaited by the body. Both resume from the body's own ALS
      // context — the explicit handle and the ROOT-bound client, which is the
      // ambient router's transaction branch.
      leakedExplicit = escaped.wait().then(() => tx.drizzle.all(bodies))
      leakedAmbient = escaped.wait().then(() => executor.drizzle.all(bodies))
      await tx.drizzle.run(insert, 'body')
    })

    await commitParked.reached()
    escaped.release()
    await settle()

    // The token died BEFORE the commit was issued, so both are refused while
    // the commit is still open on the connection.
    await expect(leakedExplicit).rejects.toBeInstanceOf(StaleTransactionError)
    await expect(leakedAmbient).rejects.toBeInstanceOf(StaleTransactionError)

    commitParked.release()
    await done

    // And neither statement ever reached the session: results alone cannot say
    // this, because a statement run during the commit still returns rows.
    expect(driver.calls.filter((call) => call.includes(':execute:'))).toEqual([
      `s1:execute:${insert}`,
    ])
    await executor.close()
  })

  it('refuses a post-commit continuation that resumes after the drain', async () => {
    // The same rule one phase later. The lease goes back to the scheduler when
    // the drain ends, so a follow-up's unawaited promise must be refused, not
    // issued on a connection somebody else now holds.
    const escaped = barrier()
    const driver = asyncFakeDriver()
    const executor = createStoreExecutor<QueryClient>({ driver })
    let leaked: Promise<unknown> | undefined

    await executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'body')
      postCommit().followUp(() => {
        leaked = escaped.wait().then(() => executor.drizzle.all(bodies))
      }, 'leak')
    })

    escaped.release()
    await expect(leaked).rejects.toBeInstanceOf(StaleTransactionError)
    await executor.close()
  })

  it('sends a late external effect to the root, not to its released lease', async () => {
    // WOULD CATCH the stale post-commit scope: an effect is never awaited, so
    // its continuation resumes after the lease is released. Routed to that
    // lease it addresses a connection the scheduler has handed back — on a
    // reusable remote client that is an out-of-order write on somebody else's
    // session, not an error.
    const parked = barrier()
    const driver = asyncFakeDriver()
    const executor = createStoreExecutor<QueryClient>({ driver })

    await executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'body')
      postCommit().effect(async () => {
        await parked.wait()
        await executor.drizzle.run(insert, 'from-effect')
      }, 'late')
    })

    expect(driver.closes, 'the lease is back with the scheduler').toBe(1)
    parked.release()
    await executor.effectsSettled()

    // A SECOND lease, taken through admission like any other root caller.
    expect(driver.opens).toBe(2)
    expect(driver.calls.filter((call) => call.includes(':execute:'))).toEqual([
      `s1:execute:${insert}`,
      `s2:execute:${insert}`,
    ])
    await executor.close()
  })
})

describe('scopes that outlive the lease they run on', () => {
  it('refuses to commit over a nested scope the body never awaited, and refuses that scope', async () => {
    // WOULD CATCH the dropped nested transaction. `runNested` claims the child
    // before its first await, so the parent can return, commit and hand the
    // connection back while the child is still parked on `enterSavepoint` —
    // and the child's own token is still valid, because nothing closed it.
    const savepointParked = barrier()
    const driver = asyncFakeDriver({
      hooks: {
        enterSavepoint: async () => {
          await savepointParked.wait()
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })
    let dropped: Promise<unknown> | undefined
    let nestedBodyRan = false

    const done = executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'outer')
      // Started and never awaited: the body returns out from under it.
      dropped = tx.transact(async (inner) => {
        nestedBodyRan = true
        await inner.drizzle.run(insert, 'nested')
      })
    })

    await expect(done).rejects.toBeInstanceOf(AbandonedNestedTransactionError)

    savepointParked.release()
    await expect(dropped).rejects.toBeInstanceOf(StaleTransactionError)
    await settle()

    // The body never RAN, not merely "its statements were refused": the
    // savepoint resolved into a unit that had already rolled back, and a body
    // with a side effect outside the store would otherwise have taken it.
    expect(nestedBodyRan).toBe(false)

    // ROLLBACK, not COMMIT, and the nested body's statement never reached the
    // session — which results cannot show, because a statement issued on a
    // released session still returns rows.
    expect(driver.calls).toEqual([
      'open:write',
      's1:begin:write',
      `s1:execute:${insert}`,
      's1:enter:podium_sp_1',
      's1:rollback',
      's1:close',
    ])
    await executor.close()
  })

  it('refuses an abandoned nested body that was already running when its parent gave up', async () => {
    // WOULD CATCH the frame close that does not CASCADE. The test above parks
    // before the savepoint opens, so the nested scope is refused by its
    // parent's state; this one parks INSIDE the body, past that check, where
    // the only thing standing between a resumed statement and a released
    // session is the nested frame's own token — which nobody closes, because
    // nobody is left to close it.
    const insideNested = barrier()
    const driver = asyncFakeDriver()
    const executor = createStoreExecutor<QueryClient>({ driver })
    let dropped: Promise<unknown> | undefined

    const done = executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'outer')
      dropped = tx.transact(async (inner) => {
        await insideNested.wait()
        await inner.drizzle.run(insert, 'nested')
      })
      // Let the nested body start and reach its barrier, then return out from
      // under it without awaiting it.
      await insideNested.reached()
    })

    await expect(done).rejects.toBeInstanceOf(AbandonedNestedTransactionError)

    insideNested.release()
    await expect(dropped).rejects.toBeInstanceOf(StaleTransactionError)
    await settle()

    // The savepoint opened and the nested body ran, and its statement STILL
    // never reached the session.
    expect(driver.calls).toEqual([
      'open:write',
      's1:begin:write',
      `s1:execute:${insert}`,
      's1:enter:podium_sp_1',
      's1:rollback',
      's1:close',
    ])
    await executor.close()
  })

  it('refuses a durable follow-up’s transaction whose promise the follow-up dropped', async () => {
    // WOULD CATCH the same escape one phase later. The drain can only wait for
    // what a step RETURNS, so a follow-up that starts a transaction and drops
    // its promise resumes after the drain ended and the lease went back to the
    // scheduler — and then begins, writes and commits on it.
    const beginParked = barrier()
    let begins = 0
    const driver = asyncFakeDriver({
      hooks: {
        begin: async () => {
          // The outer transaction's own BEGIN must not park; the follow-up's must.
          if (++begins === 2) await beginParked.wait()
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({ driver })
    let dropped: Promise<unknown> | undefined

    await executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'body')
      postCommit().followUp(() => {
        dropped = executor.transact(async (inner) => {
          await inner.drizzle.run(insert, 'follow-up')
        })
      }, 'leak')
    })

    expect(driver.closes, 'the drain ended and the lease is back with the scheduler').toBe(1)

    beginParked.release()
    await expect(dropped).rejects.toBeInstanceOf(StaleTransactionError)
    await settle()

    // The dropped transaction's BEGIN was issued while the drain still held the
    // lease; nothing after it was. No second execute, and no second COMMIT on a
    // connection somebody else may already hold.
    expect(driver.calls).toEqual([
      'open:write',
      's1:begin:write',
      `s1:execute:${insert}`,
      's1:commit',
      's1:begin:write',
      's1:close',
    ])
    await executor.close()
  })

  it('refuses a root write that was already queued when a commit application failed', async () => {
    // WOULD CATCH the unfenced queue. Both ambient routers check health before
    // they ask for a slot, and then wait in admission: a write queued behind
    // the very transaction whose mechanism-1 step fails got its slot after the
    // store became unhealthy and committed into it anyway.
    const applying = barrier()
    const diverged = new Error('the projection no longer matches the database')
    const driver = asyncFakeDriver()
    const executor = createStoreExecutor<QueryClient>({ driver, onUnhealthy: () => undefined })

    const first = executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'first')
      postCommit().applyCommit(async () => {
        await applying.wait()
        throw diverged
      }, 'fold')
    })

    // The lease is held by the parked commit application, so this WAITS.
    await applying.reached()
    const queued = executor.drizzle.run(insert, 'queued')
    await settle()
    applying.release()

    await expect(first).rejects.toMatchObject({ committed: true })
    await expect(first).rejects.toBeInstanceOf(StoreUnhealthyError)
    // Refused, and refused as NOT committed: nothing of it was written.
    await expect(queued).rejects.toBeInstanceOf(StoreUnhealthyError)
    await expect(queued).rejects.toMatchObject({ committed: false })
    expect(executor.health.healthy).toBe(false)

    // It got its slot and its connection, and was turned away there: one
    // execute in the whole log, the first transaction's.
    expect(driver.calls).toEqual([
      'open:write',
      's1:begin:write',
      `s1:execute:${insert}`,
      's1:commit',
      's1:close',
      'open:write',
      's2:close',
    ])
    await executor.close()
  })

  it('refuses the committed-view read from a context that resumes after the commit', async () => {
    // WOULD CATCH `outsideTransaction` branching on the transaction scope
    // without checking its token. The context is permission to look outside a
    // transaction that is still OPEN; a continuation the body left in flight
    // carries that context with it and would otherwise read the committed view
    // successfully, long after "nothing runs after its commit".
    const h = open()
    const escaped = barrier()
    let leaked: Promise<unknown> | undefined

    await h.executor.transact(async (tx) => {
      leaked = escaped
        .wait()
        .then(() => h.executor.outsideTransaction(async (view) => noteBodies(view.drizzle)))
      await tx.drizzle.run(insert, 'committed')
    })

    escaped.release()
    await expect(leaked).rejects.toBeInstanceOf(StaleTransactionError)
    // And no reader connection was ever opened: the refusal is at the token,
    // not a lucky failure further in.
    expect(h.log.entries.filter((entry) => entry.startsWith('r'))).toEqual([])
    expect(await noteBodies(h.db)).toEqual(['committed'])
  })
})

describe('post-commit runner retention', () => {
  it('holds no runner after writes whose post-commit work is done', async () => {
    // WOULD CATCH the leak: the executor owned a strong `Set` a runner was only
    // ever added to. One runner, queue, effect set and option closure per root
    // write — including writes with no post-commit work at all — kept for the
    // life of the process, with `effectsSettled()` scanning all of them.
    const h = open()
    for (let i = 0; i < 12; i++) {
      await h.executor.transact(async (tx) => {
        await tx.drizzle.run(insert, `sequential-${i}`)
      })
    }
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        h.executor.transact(async (tx) => {
          await tx.drizzle.run(insert, `burst-${i}`)
          // A settled effect must not keep its runner either.
          postCommit().effect(() => undefined, 'done')
        }),
      ),
    )
    await h.executor.effectsSettled()
    await settle()

    expect(h.executor.diagnostics.retainedRunners).toBe(0)
  })

  it('keeps a runner exactly until its delayed effect settles', async () => {
    // The other half: removal must not race `effectsSettled()`, which would
    // make the executor stop waiting for effects still in flight.
    const parked = barrier()
    const h = open()
    const ran: string[] = []

    await h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'committed')
      postCommit().effect(async () => {
        await parked.wait()
        ran.push('late')
      }, 'late')
    })
    await settle()
    expect(h.executor.diagnostics.retainedRunners, 'still owed an effect').toBe(1)

    const settled = h.executor.effectsSettled()
    parked.release()
    await settled
    expect(ran, 'effectsSettled waited for the effect it still owned').toEqual(['late'])
    await settle()
    expect(h.executor.diagnostics.retainedRunners).toBe(0)
  })
})

describe('frames per burst', () => {
  it('publishes one frame for the boot-reconcile burst and one for a bind storm', async () => {
    // WOULD CATCH the flip's most likely publication regression: with every
    // commit awaited, a microtask-boundary flush turns a burst of N commits
    // into N frames per connection. The flush signal is the scheduler going
    // idle, so a burst is one frame however many commits it contains.
    const h = open()
    const frames: number[][] = []
    const flusher = createFrameFlusher<number>({
      scheduler: h.executor.scheduler,
      flush: (batch) => frames.push([...batch]),
    })

    // Boot reconcile: one unit of work, many reconciled entities.
    await h.executor.transact(async (tx) => {
      for (let i = 0; i < 50; i++) {
        await tx.drizzle.run(insert, `reconcile-${i}`)
        flusher.publish(i)
      }
    })
    expect(flusher.frames).toBe(1)
    expect(frames[0]).toHaveLength(50)

    // Bind storm: many commits issued as one burst.
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        h.executor.transact(async (tx) => {
          await tx.drizzle.run(insert, `bind-${i}`)
          postCommit().effect(() => flusher.publish(i), 'publish')
        }),
      ),
    )
    await h.executor.effectsSettled()
    expect(flusher.frames).toBe(2)
    expect(frames[1]).toHaveLength(30)
    flusher.stop()
  })
})

describe('the watchdog', () => {
  it('reports a body holding its connection past the budget, through the injected sink', async () => {
    const reports: { lane: string; budgetMs: number }[] = []
    let announce: () => void = () => undefined
    const reported = new Promise<void>((resolve) => {
      announce = resolve
    })
    const h = open({
      watchdog: {
        budgetMs: 1,
        report: (report) => {
          reports.push({ lane: report.lane, budgetMs: report.budgetMs })
          announce()
        },
      },
    })

    // The body ends when the report arrives, so the test waits for the event
    // rather than for a duration.
    await h.executor.transact(async (tx) => {
      await reported
      await tx.drizzle.run(insert, 'slow')
    })

    expect(reports).toEqual([{ lane: 'write', budgetMs: 1 }])
  })
})

describe('shutdown', () => {
  it('drains queued work, then refuses new work', async () => {
    const h = open()
    const parked = barrier()
    const first = h.executor.transact(async (tx) => {
      await parked.wait()
      await tx.drizzle.run(insert, 'first')
    })
    const queued = h.executor.transact(async (tx) => {
      await tx.drizzle.run(insert, 'queued')
    })

    await parked.reached()
    const closing = h.executor.close()
    parked.release()
    await Promise.all([first, queued, closing])

    await expect(h.executor.transact(async () => undefined)).rejects.toBeInstanceOf(
      SchedulerClosedError,
    )
    harness = undefined
  })
})
