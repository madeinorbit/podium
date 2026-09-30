// @vitest-environment happy-dom
/**
 * POD-4944 — the harness adapter wraps the product entry points.
 *
 * - (a) IDENTITY. `harnessMobxPoolArm.create` and
 *   `harnessWritableMobxPoolArm(...).create(...)` run the product arms: the
 *   harness handle's pool IS the pool the product factory built (spied from
 *   outside). A copied `create` body that builds its own pool never calls the
 *   product arm, so this fails on it.
 * - (b) RECEIPTS THROUGH THE PRODUCT WIRING. A receipted edit made through
 *   `harnessWritableMobxPoolArm` expires at the TTL on the product default
 *   path (real `setTimeout`, faked here — no injected `schedule`). The
 *   receipt arrives as a transport event, so it travels the product write
 *   arm's own subscription: PL1 (the product arm ignoring `accepted`) leaves
 *   the edit pending past the TTL and fails this.
 * - (c) DISPOSE. Disposing a harness handle releases the feed and transport
 *   subscriptions it took (counted from outside).
 */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as productPool from '@podium/client-graph/create'
import { installMobxWarnTrap } from '../mobx-trap'
import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import {
  ECHO_TTL_MS,
  type KernelCommand,
  type TxId,
  type WriteEvent,
  type WriteTransport,
} from '@podium/client-graph/shared/write-contract'
import { openFenceFeeds } from '../fence-scenarios'
import {
  harnessMobxPoolArm,
  harnessWritableMobxPoolArm,
  tracked,
  type HarnessWritableMobxPoolHandle,
} from './mobx-pool'

installMobxWarnTrap()

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface FakeTransport extends WriteTransport {
  readonly sent: { txId: TxId; command: KernelCommand }[]
  readonly listeners: Set<(event: WriteEvent) => void>
  fire(event: WriteEvent): void
}

function fakeTransport(): FakeTransport {
  const sent: { txId: TxId; command: KernelCommand }[] = []
  const listeners = new Set<(event: WriteEvent) => void>()
  return {
    sent,
    listeners,
    send(txId, command) {
      sent.push({ txId, command })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pending() {
      return []
    },
    fire(event) {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

function titleOf(handle: HarnessWritableMobxPoolHandle, id: string): string | undefined {
  return tracked(() => (handle.pool.inputs.issue(id) as SliceIssue | undefined)?.title)
}

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

  it("the harness writable handle's pool is the product write arm's pool", async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const transport = fakeTransport()
    try {
      // Both product lifecycles use the product pool factory. Its one returned
      // pool must be the pool exposed by the prototype's writable handle.
      const create = vi.spyOn(productPool, 'createWorklistPool')
      const handle = harnessWritableMobxPoolArm(transport).create(
        feeds.rows.source,
        feeds.locals.source,
      ) as HarnessWritableMobxPoolHandle
      try {
        expect(create).toHaveBeenCalledTimes(1)
        const result = create.mock.results[0]
        if (result === undefined || result.type !== 'return') {
          throw new Error('the product create returned nothing to compare against')
        }
        expect(handle.pool).toBe(result.value.pool)
        expect(handle.write).toBeDefined()
      } finally {
        handle.dispose()
      }
    } finally {
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('a receipted edit through the harness writable arm expires at the TTL on the product default path', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    try {
      const transport = fakeTransport()
      // Fake timers BEFORE create: the product default path arms a real
      // `setTimeout` for the TTL and reads `Date.now` — both faked here, no
      // injected schedule.
      vi.useFakeTimers()
      const handle = harnessWritableMobxPoolArm(transport).create(
        feeds.rows.source,
        feeds.locals.source,
      ) as HarnessWritableMobxPoolHandle
      try {
        const id = ctx.targets.visibleRootId
        const serverTitle = titleOf(handle, id) as string
        let tx = '' as TxId
        act(() => {
          tx = handle.write.edit('issue', id, { title: 'Expiring through the product arm' })
        })
        expect(titleOf(handle, id)).toBe('Expiring through the product arm')
        // The receipt arrives as a transport event: the product write arm's
        // own subscription carries it (PL1 breaks this leg).
        act(() => {
          transport.fire({ type: 'accepted', txId: tx })
        })
        expect(handle.write.log.pendingFor('issue', id)).toHaveLength(1)
        act(() => {
          vi.advanceTimersByTime(ECHO_TTL_MS - 1)
        })
        expect(titleOf(handle, id)).toBe('Expiring through the product arm')
        expect(handle.write.log.pendingFor('issue', id)).toHaveLength(1)
        act(() => {
          vi.advanceTimersByTime(1)
        })
        expect(titleOf(handle, id)).toBe(serverTitle)
        expect(handle.write.log.size).toBe(0)
      } finally {
        handle.dispose()
      }
    } finally {
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('dispose releases the feed and transport subscriptions', async () => {
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

      const transport = fakeTransport()
      const writable = harnessWritableMobxPoolArm(transport).create(
        countedSource,
        countedLocals,
      ) as HarnessWritableMobxPoolHandle
      // The pool's feed subscription plus the write layer's remoteRows one.
      expect(rowSubs).toBe(2)
      expect(localSubs).toBe(1)
      expect(transport.listeners.size).toBe(1)
      writable.dispose()
      expect(rowSubs).toBe(0)
      expect(localSubs).toBe(0)
      expect(transport.listeners.size).toBe(0)
    } finally {
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
