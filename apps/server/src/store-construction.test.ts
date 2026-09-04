/**
 * Assertion custody for the synchronous query capability (spec rule 21).
 *
 * POD-3338 originally pinned the refusal in SyncRepository. POD-3416 moved the
 * guard with rule 27b to SessionStore, but its replacement test only exercised
 * the caller-owned query capability's happy path. This test moves the refusal
 * assertion to the composition root that now owns it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient, RootStoreExecutor } from './store/executor'

const executorFixture = vi.hoisted(() => ({
  constructed: [] as RootStoreExecutor<QueryClient>[],
}))

vi.mock('./store/executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store/executor')>()
  return {
    ...actual,
    createBunStoreExecutor: (
      ...args: Parameters<typeof actual.createBunStoreExecutor>
    ): RootStoreExecutor<QueryClient> => {
      const executor = actual.createBunStoreExecutor(...args)
      Object.defineProperty(executor, 'syncQueries', { value: undefined })
      executorFixture.constructed.push(executor)
      return executor
    },
  }
})

import { SessionStore } from './store'

const MISSING_SYNC_QUERIES_MESSAGE =
  'SessionStore: the synchronous query capability is absent — the handle is not ' +
  'bun-backed, so converted repositories cannot be constructed (POD-3221 rule 27b).'

function constructionErrorWithoutSyncQueries(): Error {
  try {
    new SessionStore(':memory:')
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('SessionStore construction unexpectedly succeeded without syncQueries')
}

afterEach(async () => {
  for (const executor of executorFixture.constructed.splice(0)) {
    await executor.close()
  }
})

describe('SessionStore query capability construction', () => {
  it('refuses when the executor has no syncQueries, with the rule 27b message', () => {
    const error = constructionErrorWithoutSyncQueries()

    expect(executorFixture.constructed).toHaveLength(1)
    expect(executorFixture.constructed[0]?.syncQueries).toBeUndefined()
    expect(error.message).toBe(MISSING_SYNC_QUERIES_MESSAGE)
  })
})
