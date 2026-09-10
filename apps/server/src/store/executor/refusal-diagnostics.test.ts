/**
 * What a refusal TELLS YOU [POD-3805, POD-3802 §2].
 *
 * The refusals themselves are pinned by `executor.test.ts`: this file is about
 * the other half of a refusal's job. POD-3802 cost a day because
 * `ParallelNestedTransactionError: transaction 4 has an open nested scope (5)`
 * names two transaction ids and no code, and because nothing logged it at all —
 * it reached the operator only as Drizzle's `Failed query: insert into "locks"`.
 *
 * So two properties, and both of them are about diagnosis rather than safety:
 *   openedAt — the stack where the scope the refusal names was OPENED, captured
 *              at the `transact`/`read` call rather than inside the frame, which
 *              is the only place the caller is still on the stack.
 *   onRefusal — one report per refused operation, at the source, so the line
 *              exists even when every layer above swallows the error.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { QueryClient } from './driver'
import {
  ParallelNestedTransactionError,
  StaleTransactionError,
  TransactionPoisonedError,
} from './errors'
import { createStoreExecutor, type StoreExecutor, type StoreRefusal } from './executor'
import { asyncFakeDriver, barrier, type Harness, openHarness } from './harness'

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

const bodies = 'SELECT body FROM notes ORDER BY id'

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return await work.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe('a refusal names where the scope it refused was opened', () => {
  it('points at the caller that opened the transaction, not at the executor', async () => {
    // WOULD CATCH: a stack captured inside `createFrame`. By then the scheduler
    // has awaited admission and the connection open, so the caller's frames are
    // gone and the capture names the executor's own internals — true, and
    // useless for finding the site that leaked the promise.
    const refusals: StoreRefusal[] = []
    const h = open({ onRefusal: (refusal) => refusals.push(refusal) })
    let escaped: StoreExecutor<QueryClient> | undefined

    // A uniquely named frame stands in for `LockService.grantTo`: the assertion
    // pins WHOSE span it was, not merely that some stack was captured.
    async function theLockSpanOpensHere(): Promise<void> {
      await h.executor.transact(async (tx) => {
        escaped = tx
      })
    }
    await theLockSpanOpensHere()

    const stale = escaped as StoreExecutor<QueryClient>
    const failure = await failureOf(stale.drizzle.all(bodies))

    expect(failure).toBeInstanceOf(StaleTransactionError)
    expect((failure as StaleTransactionError).openedAt).toContain('theLockSpanOpensHere')
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.label).toBe('statement')
    expect(refusals[0]?.lane).toBe('write')
    expect(refusals[0]?.frameId).toBeGreaterThan(0)
    expect(refusals[0]?.openedAt).toContain('theLockSpanOpensHere')
  })

  it('points at the nested scope that blocks a statement, not only at its span', async () => {
    // THE POD-3802 SHAPE. The refused statement belongs to the lock span; the
    // bug is the unawaited `sendMail` whose transaction joined it as a
    // savepoint. Only the CHILD's open site names the defect, so the refusal
    // carries both.
    const refusals: StoreRefusal[] = []
    const h = open({ onRefusal: (refusal) => refusals.push(refusal) })
    const parked = barrier()

    await h.executor.transact(async (tx) => {
      async function theMailWriteOpensHere(): Promise<void> {
        await tx.transact(async () => {
          await parked.wait()
        })
      }
      // Claimed in this turn, before its first await — so the next statement on
      // the parent is refused rather than interleaved.
      const branch = theMailWriteOpensHere()

      const failure = await failureOf(tx.drizzle.all(bodies))
      expect(failure).toBeInstanceOf(ParallelNestedTransactionError)
      const refusal = failure as ParallelNestedTransactionError
      expect(refusal.nestedOpenedAt).toContain('theMailWriteOpensHere')
      // The span that was refused is the OUTER one, opened in this test body.
      expect(refusal.openedAt).not.toContain('theMailWriteOpensHere')

      parked.release()
      await branch
    })

    expect(refusals.map((refusal) => refusal.label)).toEqual(['statement'])
    expect(refusals[0]?.nestedOpenedAt).toContain('theMailWriteOpensHere')
  })

  it('carries the open site on a poisoned transaction too', async () => {
    const refusals: StoreRefusal[] = []
    const driver = asyncFakeDriver({
      hooks: {
        releaseSavepoint: async () => {
          throw new Error('RELEASE failed')
        },
      },
    })
    const executor = createStoreExecutor<QueryClient>({
      driver,
      onRefusal: (refusal) => refusals.push(refusal),
    })

    async function thePoisonedSpanOpensHere(): Promise<void> {
      await executor.transact(async (tx) => {
        await failureOf(tx.transact(async () => undefined))
      })
    }
    const failure = await failureOf(thePoisonedSpanOpensHere())

    expect(failure).toBeInstanceOf(TransactionPoisonedError)
    expect((failure as TransactionPoisonedError).openedAt).toContain('thePoisonedSpanOpensHere')
    expect(refusals.map((refusal) => refusal.label)).toEqual(['transact'])
    await executor.close()
  })
})

describe('the refusal report', () => {
  it('reports once per refused operation, not once per layer that rethrows it', async () => {
    // WOULD CATCH: reporting in a `catch` at every seam. The body rethrows the
    // statement's refusal, so the transaction rejects with the SAME object — and
    // an operator reading one line per layer cannot tell one refusal from four.
    const refusals: StoreRefusal[] = []
    const h = open({ onRefusal: (refusal) => refusals.push(refusal) })
    const parked = barrier()

    const failure = await failureOf(
      h.executor.transact(async (tx) => {
        const branch = tx.transact(async () => {
          await parked.wait()
        })
        try {
          await tx.drizzle.all(bodies)
        } finally {
          parked.release()
          await branch
        }
      }),
    )

    expect(failure).toBeInstanceOf(ParallelNestedTransactionError)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.label).toBe('statement')
  })

  it('does not let a broken refusal sink become the failure it was reporting', async () => {
    // The same guard `effectSink` has: a logger adapter that throws must not
    // change what the caller is told, and must not be silent about itself.
    const reportFailures: unknown[] = []
    const h = open({
      onRefusal: () => {
        throw new Error('the refusal sink is broken')
      },
      onReportFailure: (error) => reportFailures.push(error),
    })
    let escaped: StoreExecutor<QueryClient> | undefined
    await h.executor.transact(async (tx) => {
      escaped = tx
    })

    const failure = await failureOf((escaped as StoreExecutor<QueryClient>).drizzle.all(bodies))

    expect(failure).toBeInstanceOf(StaleTransactionError)
    expect(reportFailures).toHaveLength(1)
  })

  it('reports the refusal a read is given, under its own label', async () => {
    const refusals: StoreRefusal[] = []
    const h = open({ onRefusal: (refusal) => refusals.push(refusal) })
    let escaped: StoreExecutor<QueryClient> | undefined
    await h.executor.read(async (tx) => {
      escaped = tx
    })

    const failure = await failureOf((escaped as StoreExecutor<QueryClient>).read(async () => 1))

    expect(failure).toBeInstanceOf(StaleTransactionError)
    expect(refusals.map((refusal) => refusal.label)).toEqual(['read'])
    expect(refusals[0]?.lane).toBe('read')
  })
})
