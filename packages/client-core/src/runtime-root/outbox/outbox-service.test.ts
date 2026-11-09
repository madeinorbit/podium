import { asMutationId, type MutationId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../../api'
import type { StoreNotices } from '../../engine/types'
import { LiveFrameQueue, type LiveFrameScheduler } from '../../live/frame-queue'
import { LiveStore } from '../../live/live-store'
import type { OutboxDeadLetterEntry, OutboxEntry } from '../../outbox'
import type { Replica } from '../../replica/kernel/facade'
import { type OutboxOutcome, OutboxService } from './outbox-service'
import type { EngineOutbox, EngineOutboxCallbacks } from './wiring'

/**
 * THE OUTBOX SERVICE (POD-6681): the queue of unsent writes, its counts in the
 * LiveStore, its recovery actions and its drain on reconnect, moved out of the
 * old store. The queue's own behaviour has its suites next to it
 * (kernel-outbox.*.test.ts, wiring.test.ts); this one covers the service.
 */

class ManualFrames implements LiveFrameScheduler {
  private pending: (() => void)[] = []
  enqueue(work: () => void): void {
    this.pending.push(work)
  }
  flush(): void {
    const batch = this.pending
    this.pending = []
    for (const work of batch) work()
  }
  dispose(): void {
    this.pending = []
  }
}

const entry = (id: string): OutboxEntry =>
  ({ mutationId: asMutationId(id), kind: 'issueDelete', input: { id }, queuedAt: 1 }) as OutboxEntry

class FakeQueue implements EngineOutbox {
  entries: OutboxEntry[] = []
  parked: OutboxDeadLetterEntry[] = []
  attaches = 0
  disposes = 0
  connected = 0
  readonly calls: string[] = []
  private listeners = new Set<(size: number) => void>()
  attach(): void {
    this.attaches += 1
  }
  dispose(): void {
    this.disposes += 1
  }
  subscribe(listener: (size: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  subscribers(): number {
    return this.listeners.size
  }
  changed(): void {
    for (const listener of [...this.listeners]) listener(this.entries.length)
  }
  size(): number {
    return this.entries.length
  }
  pending(): OutboxEntry[] {
    return this.entries
  }
  awaiting(): OutboxEntry[] {
    return []
  }
  deadLetters(): OutboxDeadLetterEntry[] {
    return this.parked
  }
  enqueue(): OutboxEntry {
    throw new Error('not in this suite')
  }
  retry(id: MutationId): void {
    this.calls.push(`retry:${id}`)
  }
  edit(id: MutationId): void {
    this.calls.push(`edit:${id}`)
  }
  discard(id: MutationId): void {
    this.calls.push(`discard:${id}`)
  }
  notifyConnected(): void {
    this.connected += 1
  }
  async drain(): Promise<void> {}
}

function setup(options: { parked?: OutboxDeadLetterEntry[]; networkEnabled?: boolean } = {}) {
  const queue = new FakeQueue()
  queue.parked = options.parked ?? []
  let callbacks!: EngineOutboxCallbacks
  const scheduler = new ManualFrames()
  const live = new LiveStore({ now: () => 1 })
  const reconnect = new Set<() => void>()
  const notices: StoreNotices = { error: vi.fn(), info: vi.fn() }
  const service = new OutboxService({
    api: {} as PodiumClientApi,
    replica: {} as Replica,
    live,
    frames: new LiveFrameQueue(scheduler),
    notices,
    connection: {
      onReconnected: (listener) => {
        reconnect.add(listener)
        return () => reconnect.delete(listener)
      },
    },
    networkEnabled: options.networkEnabled ?? true,
    createOutboxFn: (given) => {
      callbacks = given
      return queue
    },
  })
  const reconnected = () => {
    for (const listener of [...reconnect]) listener()
  }
  return { queue, callbacks, frames: scheduler, live, service, reconnected, reconnect, notices }
}

const parkedEntry = (id: string): OutboxDeadLetterEntry =>
  ({
    entry: entry(id),
    reason: { code: 'invalid' },
    parkedAt: 1,
  }) as unknown as OutboxDeadLetterEntry

describe('the outbox counts in the LiveStore', () => {
  it('shows the parked writes on the first paint, before start', () => {
    const parked = [parkedEntry('p1')]
    const { live } = setup({ parked })
    expect(live.outbox).toEqual({ pending: 0, deadLetters: parked })
  })

  it('writes the pending count with the frame on start and on every queue change', () => {
    const { queue, frames, live, service } = setup()
    queue.entries = [entry('a')]
    service.start()
    expect(live.outbox.pending).toBe(0)
    frames.flush()
    expect(live.outbox.pending).toBe(1)
    queue.entries = [entry('a'), entry('b'), entry('c')]
    queue.changed()
    frames.flush()
    expect(live.outbox.pending).toBe(3)
  })

  it('publishes a park at its own event, even before start', () => {
    const { queue, callbacks, frames, live } = setup()
    const parked = parkedEntry('p2')
    queue.parked = [parked]
    callbacks.onDeadLetter?.(parked)
    frames.flush()
    expect(live.outbox.deadLetters).toEqual(queue.parked)
  })
})

describe('draining and recovery', () => {
  it('drains when the connection says its health returned', () => {
    const { queue, service, reconnected } = setup()
    service.start()
    reconnected()
    expect(queue.connected).toBe(1)
  })

  it("answers a person's recovery of a parked write on the queue", () => {
    const { queue, service } = setup()
    const id = asMutationId('p1')
    service.recovery.retry(id, { confirmed: true })
    service.recovery.edit(id, {})
    service.recovery.discard(id)
    expect(queue.calls).toEqual(['retry:p1', 'edit:p1', 'discard:p1'])
  })

  it('hands a local-only boot the offline seams: nothing sends', () => {
    const { callbacks } = setup({ networkEnabled: false })
    expect(callbacks.isOnline?.()).toBe(false)
  })

  it('reports outcomes to observers, after its own handling, and survives a throwing one', () => {
    const { callbacks, service } = setup()
    const seen: OutboxOutcome[] = []
    service.subscribeOutcomes(() => {
      throw new Error('observer')
    })
    service.subscribeOutcomes((outcome) => seen.push(outcome))
    expect(callbacks.observingSupersede?.()).toBe(true)
    callbacks.onApplied?.(entry('a'))
    callbacks.onSuperseded?.(asMutationId('b'), undefined)
    expect(seen.map((o) => o.type)).toEqual(['applied', 'superseded'])
  })

  it('releases a chat send waiting on its entry', async () => {
    const { callbacks, service } = setup()
    const id = asMutationId('send-1')
    const wait = service.settlements.next(id)
    callbacks.onSettled?.(id, { outcome: 'applied' } as never)
    await expect(wait.settled).resolves.toEqual({ outcome: 'applied' })
  })
})

describe('lifecycle', () => {
  it('starts nothing twice across a StrictMode remount (start, stop, start)', () => {
    const { queue, service, reconnect } = setup()
    service.start()
    service.start()
    service.stop()
    service.start()
    expect(queue.attaches).toBe(2)
    expect(queue.disposes).toBe(1)
    expect(queue.subscribers()).toBe(1)
    expect(reconnect.size).toBe(1)
  })

  it('fires nothing after sign-out', () => {
    const { queue, callbacks, frames, live, service, reconnected } = setup()
    const seen = vi.fn()
    service.subscribeOutcomes(seen)
    service.start()
    frames.flush()
    service.dispose()
    service.dispose()
    expect(queue.disposes).toBe(1)
    service.start()
    reconnected()
    queue.entries = [entry('late')]
    queue.changed()
    callbacks.onApplied?.(entry('late'))
    callbacks.onDeadLetter?.(parkedEntry('late'))
    frames.flush()
    expect(queue.attaches).toBe(1)
    expect(queue.connected).toBe(0)
    expect(seen).not.toHaveBeenCalled()
    expect(live.outbox.pending).toBe(0)
  })
})
