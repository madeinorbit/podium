import { IssueWire } from '@podium/model/browser'
import { makeIssue } from './test-issue'
import { WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { asUserId } from '@podium/model'
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const params = new URL(url, 'http://localhost').searchParams
        const seq = Number(params.get('from') ?? 0)
        return syncResponse(seq, [], 'delta')
      }),
    )
  })

  afterEach(async () => {
    await first?.dispose()
    await second?.dispose()
    vi.unstubAllGlobals()
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
    first.feed.connected(true)
    second.feed.connected(true)

    const observer = second.createReplicaFn(asClientPrincipal(asUserId('alice')))
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
    await vi.waitFor(() => {
      expect(observer.rows('issues')).toEqual([
        expect.objectContaining({ id: 'issue-1', title: 'from the first tab' }),
      ])
    })
    await Promise.all([first.store.settled(), second.store.settled()])

    expect(changed).toHaveBeenCalled()
    expect(channels[0]?.posted).toHaveLength(1)

    // If the second socket also receives the authority frame, the cross-tab copy
    // wins the race and the socket duplicate becomes a no-op rather than a heal.
    const notifications = changed.mock.calls.length
    second.feed.frame(frame)
    await second.store.settled()
    expect(changed).toHaveBeenCalledTimes(notifications)

    unsubscribe()
  })

  it('relays a rescope eviction and ignores the second socket duplicate', async () => {
    const factory = new IDBFactory()
    const databaseName = `kernel-cross-tab-rescope-${Date.now()}`
    const options = {
      trpc,
      factory: factory as never,
      databaseName,
      evidence: { kind: 'single-account', principal: 'default' } as const,
      principal: 'alice',
      broadcastChannelFactory: (name: string) => new FakeBroadcastChannel(name),
    }
    first = await openKernelAssembly(options)
    second = await openKernelAssembly(options)
    const initiallyVisible = [
      {
        seq: 1,
        entity: 'issue',
        entityId: 'revoked-issue',
        op: 'upsert' as const,
        value: IssueWire.parse(makeIssue({ id: 'revoked-issue', title: 'visible before rescope' })),
      },
    ]
    let requests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        requests += 1
        return syncResponse(requests <= 2 ? 1 : 2, requests <= 2 ? initiallyVisible : [])
      }),
    )
    first.feed.connected(false)
    second.feed.connected(false)

    const firstObserver = first.createReplicaFn(asClientPrincipal(asUserId('alice')))
    const secondObserver = second.createReplicaFn(asClientPrincipal(asUserId('alice')))
    await vi.waitFor(() => {
      expect(firstObserver.rows('issues')).toHaveLength(1)
      expect(secondObserver.rows('issues')).toHaveLength(1)
      expect(first?.progress.getSnapshot().phase).toBe('ready')
      expect(second?.progress.getSnapshot().phase).toBe('ready')
    })

    const changed = vi.fn()
    const unsubscribe = secondObserver.subscribeRows('issues', changed)
    const frame = {
      type: 'feedRescope' as const,
      feedId: 'feed-1',
      epoch: 'epoch-1',
      seq: 2,
      cause: 'rights-changed' as const,
    }
    first.feed.frame(frame)
    await vi.waitFor(() => {
      expect(firstObserver.rows('issues')).toEqual([])
      expect(secondObserver.rows('issues')).toEqual([])
      expect(requests).toBe(4)
    })
    await Promise.all([first.store.settled(), second.store.settled()])

    expect(changed).toHaveBeenCalled()

    const notifications = changed.mock.calls.length
    second.feed.frame(frame)
    await second.store.settled()
    expect(changed).toHaveBeenCalledTimes(notifications)
    expect(requests).toBe(4)

    unsubscribe()
  })
})

function syncResponse(
  seq: number,
  changes: unknown[],
  mode: 'snapshot' | 'delta' = 'snapshot',
): Response {
  const values = [
    {
      type: 'syncMeta',
      formatVersion: 1,
      mode,
      transferId: 'test',
      feedId: 'feed-1',
      epoch: 'epoch-1',
      seq,
      minAvailableSeq: 0,
      wireVersion: WIRE_VERSION,
      wireSchemaDigest: wireSchemaDigest(),
      ...(mode === 'snapshot' ? { totalRows: changes.length } : { fromSeq: seq }),
    },
    ...(mode === 'snapshot'
      ? [
          {
            type: 'feedBootstrap',
            feedId: 'feed-1',
            epoch: 'epoch-1',
            fromSeq: 0,
            seq,
            minAvailableSeq: 0,
            changes,
            last: true,
          },
        ]
      : []),
    {
      type: 'syncComplete',
      transferId: 'test',
      seq,
      records: mode === 'snapshot' ? 1 : 0,
      rows: changes.length,
    },
  ]
  return new Response(values.map((v) => JSON.stringify(v) + '\n').join(''), {
    headers: { 'content-type': 'application/x-ndjson' },
  })
}
