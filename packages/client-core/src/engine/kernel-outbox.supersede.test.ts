/**
 * POD-4554 — naming a superseded entry costs a scan of the kernel's pending
 * records per collapsible enqueue, and that scan must not ride the production
 * write path. It runs only when `onSuperseded` is registered AND
 * `observingSupersede` does not say no.
 *
 * The instrument counts `KernelOutbox.pending()` calls during one enqueue and
 * compares against an enqueue of a kind with NO collapse key, which never
 * scanned: equal means no scan, one more means exactly the scan.
 */

import type { MutationId } from '@podium/model'
import { asMutationId } from '@podium/model'
import { InMemoryOutboxStore, Outbox as KernelOutbox } from '@podium/sync/outbox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/replica'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { StoreNotices } from './types'
import type { EngineOutbox, EngineOutboxCallbacks } from './wiring'

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

const tx = (n: number): MutationId =>
  asMutationId(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)

/** Offline, so no drain runs inside an enqueue and adds its own reads. */
async function openOffline(extra: Partial<EngineOutboxCallbacks>): Promise<EngineOutbox> {
  const api = {} as PodiumClientApi
  const create = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore([]),
    principal: 'user-1',
    api,
    onDegraded: (detail) => {
      throw detail instanceof Error ? detail : new Error(String(detail))
    },
    now: () => 1_000,
  })
  return create({
    api,
    replica: {
      outboxStorage: memoryStorage,
      outboxAwaitingStorage: memoryStorage,
      outboxDeadLetterStorage: memoryStorage,
    } as unknown as Replica,
    notices: { error: () => {}, info: () => {}, warn: () => {} } as unknown as StoreNotices,
    isOnline: () => false,
    onlineEvents: { add: () => {}, remove: () => {} },
    ...extra,
  })
}

/** `pending()` reads during one enqueue: [collapsible mark-read, no-collapse update]. */
async function readsPerEnqueue(
  outbox: EngineOutbox,
): Promise<{ markRead: number; update: number }> {
  const spy = vi.spyOn(KernelOutbox.prototype, 'pending')
  await outbox.enqueue('issueMarkRead', { id: 'i1' }, { mutationId: tx(1) })
  spy.mockClear()
  await outbox.enqueue('issueMarkRead', { id: 'i1' }, { mutationId: tx(2) })
  const markRead = spy.mock.calls.length
  spy.mockClear()
  await outbox.enqueue('issueUpdate', { id: 'i2', patch: { title: 'T' } }, { mutationId: tx(3) })
  const update = spy.mock.calls.length
  spy.mockRestore()
  return { markRead, update }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the supersede scan is gated on an observer', () => {
  it('no onSuperseded: a collapsible enqueue reads pending() no more than one that cannot collapse', async () => {
    const outbox = await openOffline({})
    const reads = await readsPerEnqueue(outbox)
    expect(reads.markRead).toBe(reads.update)
    // The kernel still collapsed: one mark-read queued, not two.
    expect(outbox.pending().map((e) => e.mutationId)).toEqual([tx(2), tx(3)])
  })

  it('onSuperseded registered but not observing: no scan, and the report carries no entry', async () => {
    const reported: [MutationId, OutboxEntry | undefined][] = []
    const outbox = await openOffline({
      onSuperseded: (id, entry) => reported.push([id, entry]),
      observingSupersede: () => false,
    })
    const reads = await readsPerEnqueue(outbox)
    expect(reads.markRead).toBe(reads.update)
    expect(reported).toEqual([[tx(1), undefined]])
  })

  it('observing: exactly one scan, and the superseded entry is named', async () => {
    const reported: [MutationId, OutboxEntry | undefined][] = []
    const outbox = await openOffline({
      onSuperseded: (id, entry) => reported.push([id, entry]),
      observingSupersede: () => true,
    })
    const reads = await readsPerEnqueue(outbox)
    expect(reads.markRead).toBe(reads.update + 1)
    expect(reported).toEqual([
      [tx(1), { mutationId: tx(1), kind: 'issueMarkRead', input: { id: 'i1' }, queuedAt: 1_000 }],
    ])
  })
})
