import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { createBunSqliteDriver } from './bun-driver'
import { SchedulerClosedError, StaleTransactionError } from './errors'
import { createStoreExecutor, postCommit } from './executor'
import { asyncFakeDriver, barrier, settle } from './harness'

function fixture() {
  const database = openDatabase(':memory:')
  database.exec('CREATE TABLE notes (body TEXT)')
  return createStoreExecutor({
    driver: createBunSqliteDriver({ database }),
    startOpen: true,
    drainGraceMs: 10,
    effectDrainGraceMs: 20,
  })
}

describe('ordered scheduler lifecycle', () => {
  it('opens, accepts, drains admitted work and persistence, then closes', async () => {
    const store = fixture()
    expect(store.scheduler.state).toBe('open')
    const held = barrier()
    const entered = barrier()
    const order: string[] = []
    const write = store.transact(async (tx) => {
      entered.release()
      await held.wait()
      await tx.drizzle.run('INSERT INTO notes VALUES (?)', 'first')
      order.push('commit')
    })
    await entered.wait()
    expect(store.scheduler.state).toBe('accepting')
    const queued = store.drizzle.run('INSERT INTO notes VALUES (?)', 'queued')
    const closing = store.close(async () => {
      await store.drizzle.run('INSERT INTO notes VALUES (?)', 'persisted')
      expect(await store.drizzle.all('SELECT body FROM notes')).toEqual([
        { body: 'first' },
        { body: 'queued' },
        { body: 'persisted' },
      ])
      order.push('persisted')
    })
    expect(store.scheduler.state).toBe('draining')
    await expect(store.drizzle.run('INSERT INTO notes VALUES (?)', 'late')).rejects.toBeInstanceOf(
      SchedulerClosedError,
    )
    held.release()
    await Promise.all([write, queued, closing])
    expect(order).toEqual(['commit', 'persisted'])
    expect(store.scheduler.state).toBe('closed')
  })

  it('rolls back a parked holder, drains persistence and rejects its leaked token', async () => {
    const store = fixture()
    const held = barrier()
    const entered = barrier()
    const resumed = barrier()
    let stale: unknown
    const write = store.transact(async (tx) => {
      await tx.drizzle.run('INSERT INTO notes VALUES (?)', 'rolled back')
      entered.release()
      await held.wait()
      try {
        await tx.drizzle.run('INSERT INTO notes VALUES (?)', 'too late')
      } catch (error) {
        stale = error
      }
      resumed.release()
    })
    const refused = expect(write).rejects.toBeInstanceOf(StaleTransactionError)
    await entered.wait()
    await store.close(async () => {
      await store.drizzle.run('INSERT INTO notes VALUES (?)', 'persisted')
      expect(await store.drizzle.all('SELECT body FROM notes')).toEqual([{ body: 'persisted' }])
    })
    await refused
    held.release()
    await resumed.wait()
    expect(stale).toBeInstanceOf(StaleTransactionError)
    expect(store.scheduler.state).toBe('closed')
  })

  it('waits for an in-flight driver call before forced rollback and close', async () => {
    const call = barrier()
    const entered = barrier()
    const fake = asyncFakeDriver({
      hooks: {
        execute: async () => {
          entered.release()
          await call.wait()
        },
      },
    })
    const store = createStoreExecutor({ driver: fake, drainGraceMs: 5 })
    const write = store.transact(async (tx) => {
      await tx.drizzle.run('parked driver call')
    })
    const refused = expect(write).rejects.toBeInstanceOf(StaleTransactionError)
    await entered.wait()
    const closing = store.close()
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(fake.calls.some((call) => call.endsWith(':rollback'))).toBe(false)
    call.release()
    await Promise.all([refused, closing])
    expect(fake.calls.some((call) => call.endsWith(':rollback'))).toBe(true)
    expect(fake.calls.some((call) => call.endsWith(':commit'))).toBe(false)
  })

  it('lets retained effects finish root writes without holding their original lease', async () => {
    const store = fixture()
    const held = barrier()
    let finished = false
    await store.transact(async () => {
      postCommit().effect(async () => {
        await held.wait()
        await store.drizzle.run('INSERT INTO notes VALUES (?)', 'effect')
        finished = true
      }, 'retained write')
    })
    const closing = store.close()
    await settle()
    expect(finished).toBe(false)
    held.release()
    await closing
    expect(finished).toBe(true)
    expect(store.diagnostics.retainedRunners).toBe(0)
  })

  it('reports unfinished effects by label and closes at the effect deadline', async () => {
    const held = barrier()
    const reports: string[] = []
    const fake = asyncFakeDriver()
    const store = createStoreExecutor({
      driver: fake,
      effectDrainGraceMs: 5,
      effectSink: (error, label) => reports.push(`${label}: ${String(error)}`),
    })
    await store.transact(async () => {
      postCommit().effect(async () => {
        await held.wait()
      }, 'slow socket')
    })
    await store.close()
    expect(reports).toEqual([
      'slow socket: Error: external effect still in flight at shutdown deadline',
    ])
    expect(store.scheduler.state).toBe('closed')
    held.release()
    await store.effectsSettled()
  })
})

it('does not resume a parked post-commit queue after its lease was revoked', async () => {
  const store = fixture()
  const held = barrier()
  const entered = barrier()
  let later = false
  const write = store.transact(async () => {
    postCommit().followUp(async () => {
      entered.release()
      await held.wait()
    }, 'parked follow-up')
    postCommit().followUp(() => {
      later = true
    }, 'must not run after close')
  })
  const refused = expect(write).rejects.toBeInstanceOf(StaleTransactionError)
  await entered.wait()
  await store.close()
  await refused
  held.release()
  await settle()
  expect(later).toBe(false)
})
