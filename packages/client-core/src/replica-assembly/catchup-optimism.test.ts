import type { PodiumClientApi } from '@podium/client-core/api'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { asIssueId, asMutationId } from '@podium/model'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { type AuthorityReadPort, InMemoryReplicaStore, Replica } from '@podium/sync/replica'
import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { createWorklistPool } from '../../../client-graph/src/create'
import { requireHere } from '../../../client-graph/src/lookup'
import { fixedLocals } from '../../../client-graph/src/shared/locals-source'
import { createRowSource } from '../../../client-graph/src/shared/row-source'
import { createPoolTransactions } from '../../../client-graph/src/write/transactions'
import type { StoreNotices } from '../engine'
import { openKernelEngineOutbox } from '../engine/kernel-outbox'

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

it.each([
  'healing',
  'stale after interruption',
] as const)('paints a real local outbox edit immediately while server publication is held: %s', async (posture) => {
  const stamp = '2026-11-01T00:00:00Z'
  const issue = (id: string, title: string) => ({
    id,
    title,
    stage: 'backlog',
    archived: false,
    parentId: null,
    deps: [],
    repoId: null,
    createdAt: stamp,
    updatedAt: stamp,
  })
  const cursor = { feedId: 'optimism-feed', epoch: 'optimism-epoch', seq: 10 }
  const cache = new InMemoryReplicaStore()
  cache.cache.installSnapshot(
    ['mine', 'remote'].map((id) => ({
      entity: 'issueProjection',
      entityId: id,
      value: issue(id, id),
      provenance: { seq: 10 },
    })),
    cursor,
    [],
  )
  const prefix = latch(),
    finish = latch()
  const authority: AuthorityReadPort = {
    bootstrap() {
      throw new Error('unexpected bootstrap')
    },
    changesRange: async () =>
      (async function* () {
        yield {
          kind: 'delta' as const,
          ...cursor,
          fromSeq: 10,
          seq: 11,
          minAvailableSeq: 0,
          changes: [
            {
              seq: 11,
              op: 'upsert' as const,
              entity: 'issueProjection',
              entityId: 'remote',
              payload: issue('remote', 'held prefix'),
            },
          ],
        }
        prefix.release()
        await finish.promise
        yield {
          kind: 'delta' as const,
          ...cursor,
          fromSeq: 11,
          seq: 12,
          minAvailableSeq: 0,
          changes: [
            {
              seq: 12,
              op: 'upsert' as const,
              entity: 'issueProjection',
              entityId: 'remote',
              payload: issue('remote', 'caught up'),
            },
          ],
        }
      })(),
  }
  const side = createSideCache({ storage: memoryStorage() })
  const facade = createKernelReplica({ cache: cache.cache, side })
  const kernel = new Replica({
    store: cache.cache,
    authority,
    onEvent: (event) => facade.onKernelEvent(event),
    batchEvents: (emit) => facade.batch(emit),
  })
  const api = {} as PodiumClientApi
  const createOutbox = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore(),
    principal: 'alice',
    api,
    onDegraded: (detail) => {
      throw detail
    },
  })
  const outbox = createOutbox({
    api,
    replica: facade,
    isOnline: () => false,
    notices: { error() {}, warn() {}, info() {} } as unknown as StoreNotices,
  })
  const subscribe = facade.subscribeAddressedBatch
  if (!subscribe) throw new Error('the kernel facade must supply addressed publications')
  const transactions = createPoolTransactions({
    userId: 'alice',
    outbox,
    outcomes: () => () => {},
    addressed: (listener) => subscribe(listener),
    enqueue: async (kind, input, opts) => {
      await outbox.enqueue(kind, input, opts)
    },
    mintId: () => asMutationId('local-stage'),
  })
  const rows = createRowSource(
    { principal: { userId: 'alice' }, readLocal: () => [], onLocals: () => () => {} },
    facade,
    { pending: transactions.pending },
  )
  transactions.bind(rows)
  const handle = createWorklistPool(
    rows.source,
    fixedLocals({ selectedIssueId: null, coarseNow: 0 }).source,
    { summaries: { issue: ['title', 'stage'] } },
  )
  handle.pool.attachTransactions(transactions)
  const stages: unknown[] = []
  const stop = autorun(() =>
    stages.push(requireHere(handle.pool.row('issue', 'mine', 'summary')).stage),
  )
  const published = vi.fn()
  const stopPublished = subscribe(published)
  try {
    kernel.connect()
    await prefix.promise
    if (posture === 'stale after interruption') kernel.disconnect()
    expect(kernel.posture).toBe(posture === 'healing' ? 'healing' : 'stale')
    const committed = transactions.write('issueUpdate', {
      id: asIssueId('mine'),
      patch: { stage: 'in_progress' },
    })
    // The synchronous repaint precedes even the local queue commit and never
    // passes through the facade's held server invalidations.
    expect(stages).toEqual(['backlog', 'in_progress'])
    expect(published).not.toHaveBeenCalled()
    expect(requireHere(handle.pool.row('issue', 'remote', 'summary')).title).toBe('remote')
    await committed
    expect(outbox.pending()).toHaveLength(1)
    expect(stages.at(-1)).toBe('in_progress')
    finish.release()
    await kernel.settled()
    expect(stages.at(-1)).toBe('in_progress')
    expect(published).toHaveBeenCalledTimes(posture === 'healing' ? 1 : 0)
  } finally {
    kernel.disconnect()
    finish.release()
    await kernel.settled()
    stopPublished()
    stop()
    handle.dispose()
    rows.dispose()
    transactions.dispose()
    outbox.dispose()
    side.dispose()
  }
})
