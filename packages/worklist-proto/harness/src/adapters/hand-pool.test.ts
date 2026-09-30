// @vitest-environment happy-dom
/**
 * POD-4944 — the hand harness adapter wraps the product entry points.
 *
 * - (a) IDENTITY. `harnessHandPoolArm.create` and
 *   `harnessWritableHandPoolArm(...).create(...)` run the product arms: the
 *   harness handle's pool IS the pool the product `create` built (spied from
 *   outside). A copied `create` body that builds its own pool never calls the
 *   product arm, so this fails on it.
 * - (b) RECEIPTS THROUGH THE PRODUCT WIRING. A rejected edit made through
 *   `harnessWritableHandPoolArm` rewinds through the product write arm's own
 *   receipt subscription (transport event → `write.reject`). PL1 (the product
 *   arm ignoring `rejected`) leaves the edit pending and fails this.
 * - (c) DISPOSE. Disposing a harness handle releases the feed and transport
 *   subscriptions it took (counted from outside).
 */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handPoolArm } from '../../../arms/hand/pool/arm'
import type { LocalsSource, RowSource } from '../../../shared/src/arm'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import type {
  KernelCommand,
  TxId,
  WriteEvent,
  WriteTransport,
} from '@podium/client-graph/shared/write-contract'
import { openFenceFeeds } from '../fence-scenarios'
import {
  harnessHandPoolArm,
  harnessWritableHandPoolArm,
  type HarnessWritableHandPoolHandle,
} from './hand-pool'

afterEach(() => {
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

function titleOf(handle: HarnessWritableHandPoolHandle, id: string): string | undefined {
  return (handle.pool.inputs.issue(id) as SliceIssue | undefined)?.title
}

describe('the hand harness adapter wraps the product entry points (POD-4944)', () => {
  it("the harness handle's pool is the product handle's pool", async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    try {
      const create = vi.spyOn(handPoolArm, 'create')
      const handle = harnessHandPoolArm.create(feeds.rows.source, feeds.locals.source)
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
      // The product write arm builds its pool through the product arm, so
      // one product `create` runs and its pool is the harness handle's pool.
      const create = vi.spyOn(handPoolArm, 'create')
      const handle = harnessWritableHandPoolArm(transport).create(
        feeds.rows.source,
        feeds.locals.source,
      ) as HarnessWritableHandPoolHandle
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

  it('a rejected edit through the harness writable arm rewinds through the product receipt wiring', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'truth')
    try {
      const transport = fakeTransport()
      const handle = harnessWritableHandPoolArm(transport).create(
        feeds.rows.source,
        feeds.locals.source,
      ) as HarnessWritableHandPoolHandle
      try {
        const id = ctx.targets.visibleRootId
        const serverTitle = titleOf(handle, id) as string
        const tx = handle.write.edit('issue', id, { title: 'Rewound through the product arm' })
        expect(titleOf(handle, id)).toBe('Rewound through the product arm')
        // The rejection arrives as a transport event: the product write
        // arm's own subscription carries it (an adapter that re-implements
        // `create` without that wiring never rewinds).
        transport.fire({ type: 'rejected', txId: tx, error: { message: 'refused', parked: false } })
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

      const bare = harnessHandPoolArm.create(countedSource, countedLocals)
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
      const writable = harnessWritableHandPoolArm(transport).create(
        countedSource,
        countedLocals,
      ) as HarnessWritableHandPoolHandle
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
