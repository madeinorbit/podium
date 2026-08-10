import { asClientPrincipal } from '@podium/client-core/principal'
import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type KernelAssembly,
  type KernelBroadcastChannel,
  openKernelAssembly,
} from './kernelReplica'

const trpc = {
  sync: {
    feedChangesSince: {
      query: async ({ cursor }: { cursor: { feedId: string; epoch: string; seq: number } }) => ({
        kind: 'delta',
        feedId: cursor.feedId,
        epoch: cursor.epoch,
        fromSeq: cursor.seq,
        seq: cursor.seq,
        minAvailableSeq: 0,
        changes: [],
      }),
    },
  },
} as unknown as Parameters<typeof openKernelAssembly>[0]['trpc']

class FakeBroadcastChannel implements KernelBroadcastChannel {
  static readonly groups = new Map<string, Set<FakeBroadcastChannel>>()
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  readonly posted: unknown[] = []

  constructor(private readonly name: string) {
    const group = FakeBroadcastChannel.groups.get(name) ?? new Set()
    group.add(this)
    FakeBroadcastChannel.groups.set(name, group)
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
    for (const peer of FakeBroadcastChannel.groups.get(this.name) ?? []) {
      if (peer !== this) peer.onmessage?.({ data: structuredClone(message) } as MessageEvent)
    }
  }

  close(): void {
    FakeBroadcastChannel.groups.get(this.name)?.delete(this)
  }
}

describe('kernel replica cross-tab convergence', () => {
  let first: KernelAssembly | undefined
  let second: KernelAssembly | undefined

  beforeEach(() => {
    localStorage.clear()
    FakeBroadcastChannel.groups.clear()
  })

  afterEach(async () => {
    await first?.dispose()
    await second?.dispose()
  })

  it('relays a socket frame into a second assembly that shares the browser client', async () => {
    const factory = new IDBFactory()
    const databaseName = `kernel-cross-tab-${Date.now()}`
    const seeded = await IndexedDbSyncStore.open({
      factory: factory as never,
      databaseName,
      onDegraded: () => {},
    })
    seeded.viewFor('alice').cache.applyAtomic({
      operations: [],
      cursor: { feedId: 'feed-1', epoch: 'epoch-1', seq: 0 },
    })
    await seeded.settled()
    seeded.close()

    const channels: FakeBroadcastChannel[] = []
    const options = {
      trpc,
      factory: factory as never,
      databaseName,
      evidence: { kind: 'single-account', principal: 'default' } as const,
      principal: 'alice',
      broadcastChannelFactory: (name: string) => {
        const channel = new FakeBroadcastChannel(name)
        channels.push(channel)
        return channel
      },
    }
    first = await openKernelAssembly(options)
    second = await openKernelAssembly(options)
    first.feed.connected()
    second.feed.connected()
    await Promise.all([first.kernel.settled(), second.kernel.settled()])

    const observer = second.createReplicaFn(asClientPrincipal('alice'))
    const changed = vi.fn()
    const unsubscribe = observer.subscribeRows('issues', changed)

    const frame = {
      type: 'feedDelta' as const,
      feedId: 'feed-1',
      epoch: 'epoch-1',
      fromSeq: 0,
      seq: 1,
      minAvailableSeq: 0,
      changes: [
        {
          seq: 1,
          entity: 'issue',
          entityId: 'issue-1',
          op: 'upsert' as const,
          value: { id: 'issue-1', title: 'from the first tab' },
        },
      ],
    }
    first.feed.frame(frame)
    await Promise.all([
      first.kernel.settled(),
      second.kernel.settled(),
      first.store.settled(),
      second.store.settled(),
    ])

    expect(observer.rows('issues')).toEqual([
      expect.objectContaining({ id: 'issue-1', title: 'from the first tab' }),
    ])
    expect(changed).toHaveBeenCalled()
    expect(channels[0]?.posted).toHaveLength(1)

    // If the second socket also receives the authority frame, the cross-tab copy
    // wins the race and the socket duplicate becomes a no-op rather than a heal.
    const notifications = changed.mock.calls.length
    second.feed.frame(frame)
    await second.kernel.settled()
    expect(changed).toHaveBeenCalledTimes(notifications)

    unsubscribe()
  })
})
