import { asMutationId, type LayoutSnapshot } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry } from '../outbox'
import { BootFetches } from './boot'
import { createReplicatedLayoutController } from './replicated-layout'
import type { StoreNotices } from './types'
import type { EngineOutbox, OutboxKinds } from './wiring'

const fold = 'sidebar.section.project-fold:repo_2928f71bab0412fa'
const other = 'sidebar.section.project-fold:another-repo'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(seed: LayoutSnapshot = {}) {
  const pending: OutboxEntry[] = []
  const awaiting: OutboxEntry[] = []
  const reads: ReturnType<typeof deferred<LayoutSnapshot>>[] = []
  let sequence = 0
  const api = {
    layout: { get: { query: () => {
      const read = deferred<LayoutSnapshot>()
      reads.push(read)
      return read.promise
    } } },
  } as unknown as PodiumClientApi
  const retireAwaiting = vi.fn((id: string) => {
    const index = awaiting.findIndex((entry) => entry.mutationId === id)
    if (index >= 0) awaiting.splice(index, 1)
    controller.outboxChanged()
  })
  const outbox = {
    pending: () => pending,
    awaiting: () => awaiting,
    enqueue: (kind: keyof OutboxKinds, input: unknown) => {
      const entry = { kind, input, mutationId: asMutationId(`layout-${++sequence}`), queuedAt: sequence }
      pending.push(entry)
      controller.outboxChanged()
      return entry
    },
    retireAwaiting,
  } as unknown as EngineOutbox
  const controller = createReplicatedLayoutController({
    api, outbox, seed,
    notices: { error: vi.fn(), info: vi.fn() } as StoreNotices,
  })
  const boot = new BootFetches({ api, replicatedLayout: controller, publish: () => {} })
  const apply = async () => {
    await Promise.resolve() // temporary paint hands off to the durable queue
    const entry = pending.shift()!
    awaiting.push(entry)
    controller.commandApplied(entry)
    controller.outboxChanged()
    return entry
  }
  return { controller, boot, pending, awaiting, reads, apply, retireAwaiting }
}

describe('replicated layout covering reads', () => {
  it('keeps a single-click reopen painted when the preceding collapse read failed', async () => {
    const h = harness()
    h.controller.set(fold, 'true')
    const close = await h.apply()
    const closeRead = h.boot.refreshReplicatedLayout([close.mutationId])
    h.reads[0]!.reject(new Error('offline'))
    await expect(closeRead).rejects.toThrow('offline')

    const painted: unknown[] = []
    h.controller.subscribe(() => painted.push(h.controller.get(fold)))
    h.controller.clear(fold)
    expect(h.controller.get(fold)).toBeUndefined()
    const open = await h.apply()
    const openRead = h.boot.refreshReplicatedLayout([open.mutationId])
    h.reads[1]!.resolve({}) // server has no collapse row
    await openRead
    h.controller.replace({})

    expect(h.controller.get(fold)).toBeUndefined()
    expect(painted.every((value) => value === undefined)).toBe(true)
    expect(h.awaiting).toEqual([])
    expect(h.retireAwaiting).toHaveBeenCalledWith(close.mutationId)
    expect(h.retireAwaiting).toHaveBeenCalledWith(open.mutationId)
  })

  it('ignores a delayed collapse read after a newer reopen read has completed', async () => {
    const h = harness()
    h.controller.set(fold, 'true')
    const close = await h.apply()
    const closeRead = h.boot.refreshReplicatedLayout([close.mutationId])
    h.controller.clear(fold)
    const open = await h.apply()
    const openRead = h.boot.refreshReplicatedLayout([open.mutationId])
    h.reads[1]!.resolve({})
    await openRead
    h.controller.replace({}) // release the accepted-value hold
    h.reads[0]!.resolve({ [fold]: 'true' })
    await closeRead

    expect(h.controller.get(fold)).toBeUndefined()
    expect(h.awaiting).toEqual([])
    // A later real change on another client still closes the group.
    h.controller.replace({ [fold]: 'true' })
    expect(h.controller.get(fold)).toBe('true')
  })

  it('recovers restored applied entries on hydration without retiring pending writes', async () => {
    const h = harness({ [fold]: 'true' })
    const restored = {
      mutationId: asMutationId('restored-collapse'), queuedAt: 0,
      kind: 'layoutSet', input: { values: { [fold]: 'true' } },
    } as OutboxEntry
    h.awaiting.push(restored)
    h.controller.set(other, 'true')
    await Promise.resolve()
    const read = h.controller.hydrate()
    h.reads[0]!.resolve({})
    await read

    expect(h.controller.get(fold)).toBeUndefined()
    expect(h.controller.get(other)).toBe('true')
    expect(h.awaiting).toEqual([])
    expect(h.pending).toHaveLength(1)
    expect(h.retireAwaiting.mock.calls).toEqual([[restored.mutationId]])
  })

  it('does not retire a command applied after the covering read started', async () => {
    const h = harness()
    const read = h.controller.hydrate()
    h.controller.set(fold, 'true')
    const close = await h.apply()
    h.reads[0]!.resolve({})
    await read

    expect(h.controller.get(fold)).toBe('true')
    expect(h.awaiting.map((entry) => entry.mutationId)).toEqual([close.mutationId])
    expect(h.retireAwaiting).not.toHaveBeenCalled()
  })

  it('does not install a read from before a rescope', async () => {
    const h = harness({ [fold]: 'true' })
    const read = h.controller.hydrate()
    h.controller.rescope({ [other]: 'true' })
    h.reads[0]!.resolve({ [fold]: 'true' })
    await read

    expect(h.controller.get(fold)).toBeUndefined()
    expect(h.controller.get(other)).toBe('true')
  })
})
