/**
 * POD-4554 — naming a superseded entry costs a scan of the kernel's pending
 * records per collapsible enqueue, and that scan must not ride the production
 * write path. It runs only when `onSuperseded` is registered AND
 * `observingSupersede` does not say no.
 *
 * The instrument counts `KernelOutbox.pending()` calls made between the
 * adapter's enqueue starting and its call into `kernel.enqueue`: zero means no
 * scan, one means exactly the scan.
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

/**
 * `pending()` reads that happen BEFORE the adapter hands the entry to
 * `kernel.enqueue`, for a second mark-read on the same issue (one to collapse).
 * Only the supersede scan reads in that window; the reads after it (the
 * size publication each event triggers) are the kernel's own and unchanged.
 */
async function scansBeforeEnqueue(outbox: EngineOutbox): Promise<number> {
  await outbox.enqueue('issueMarkRead', { id: 'i1' }, { mutationId: tx(1) })
  const log: string[] = []
  const pending = KernelOutbox.prototype.pending
  const enqueue = KernelOutbox.prototype.enqueue
  vi.spyOn(KernelOutbox.prototype, 'pending').mockImplementation(function (this: KernelOutbox) {
    log.push('pending')
    return pending.call(this)
  })
  vi.spyOn(KernelOutbox.prototype, 'enqueue').mockImplementation(function (
    this: KernelOutbox,
    request,
  ) {
    log.push('enqueue')
    return enqueue.call(this, request)
  })
  await outbox.enqueue('issueMarkRead', { id: 'i1' }, { mutationId: tx(2) })
  vi.restoreAllMocks()
  expect(log).toContain('enqueue')
  return log.indexOf('enqueue')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the supersede scan is gated on an observer', () => {
  it('no onSuperseded: a collapsible enqueue reads pending() no more than one that cannot collapse', async () => {
    const outbox = await openOffline({})
    expect(await scansBeforeEnqueue(outbox)).toBe(0)
    // The kernel still collapsed: one mark-read queued, not two.
    expect(outbox.pending().map((e) => e.mutationId)).toEqual([tx(2)])
  })

  it('onSuperseded registered but not observing: no scan, and the report carries no entry', async () => {
    const reported: [MutationId, OutboxEntry | undefined][] = []
    const outbox = await openOffline({
      onSuperseded: (id, entry) => reported.push([id, entry]),
      observingSupersede: () => false,
    })
    expect(await scansBeforeEnqueue(outbox)).toBe(0)
    expect(reported).toEqual([[tx(1), undefined]])
  })

  it('observing: exactly one scan, and the superseded entry is named', async () => {
    const reported: [MutationId, OutboxEntry | undefined][] = []
    const outbox = await openOffline({
      onSuperseded: (id, entry) => reported.push([id, entry]),
      observingSupersede: () => true,
    })
    expect(await scansBeforeEnqueue(outbox)).toBe(1)
    expect(reported).toEqual([
      [tx(1), { mutationId: tx(1), kind: 'issueMarkRead', input: { id: 'i1' }, queuedAt: 1_000 }],
    ])
  })
})
