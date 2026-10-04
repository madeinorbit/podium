// @vitest-environment happy-dom
/**
 * POD-4944 — the harness adapter wraps the product entry points.
 *
 * - (a) IDENTITY. `harnessMobxPoolArm.create` runs the product arm: the
 *   harness handle's pool IS the pool the product factory built (spied from
 *   outside). A copied `create` body that builds its own pool never calls the
 *   product arm, so this fails on it.
 * - (c) DISPOSE. Disposing a harness handle releases the feed subscriptions
 *   it took (counted from outside).
 *
 * POD-5432 removed (b), the writable arm's receipts: the arm that owns
 * optimism is now this arm on the `owned` feed, and the transaction log's
 * settlement is checked against the ledger (`pool-transactions.test.ts`).
 */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as productPool from '@podium/client-graph/create'
import { installMobxWarnTrap } from '../mobx-trap'
import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { openFenceFeeds } from '../fence-scenarios'
import { harnessMobxPoolArm } from './mobx-pool'

installMobxWarnTrap()

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the harness adapter wraps the product entry points (POD-4944)', () => {
  it("the harness handle's pool is the product handle's pool", async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    try {
      const create = vi.spyOn(productPool, 'createWorklistPool')
      const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
      try {
        expect(create).toHaveBeenCalledTimes(1)
        const result = create.mock.results[0]
        if (result === undefined || result.type !== 'return') {
          throw new Error('the product create returned nothing to compare against')
        }
        expect(handle.pool).toBe(result.value.pool)
      } finally {
        handle.dispose()
      }
    } finally {
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('dispose releases the feed subscriptions', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    try {
      let rowSubs = 0
      const countedSource: RowSource = {
        ...feeds.rows.source,
        subscribe: (listener) => {
          rowSubs += 1
          const off = feeds.rows.source.subscribe(listener)
          return () => {
            rowSubs -= 1
            off()
          }
        },
      }
      let localSubs = 0
      const countedLocals: LocalsSource = {
        get: () => feeds.locals.source.get(),
        subscribe: (listener) => {
          localSubs += 1
          const off = feeds.locals.source.subscribe(listener)
          return () => {
            localSubs -= 1
            off()
          }
        },
      }

      const bare = harnessMobxPoolArm.create(countedSource, countedLocals)
      expect(rowSubs).toBe(1)
      expect(localSubs).toBe(1)
      // The adapter's mount bookkeeping unmounts cleanly (twice is a no-op).
      const el = document.createElement('div')
      document.body.appendChild(el)
      try {
        let unmount!: () => void
        act(() => {
          unmount = bare.mountWeb(el)
        })
        act(() => {
          bare.settleLoads()
        })
        act(() => {
          unmount()
        })
        act(() => {
          unmount()
        })
      } finally {
        el.remove()
      }
      bare.dispose()
      expect(rowSubs).toBe(0)
      expect(localSubs).toBe(0)

    } finally {
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
