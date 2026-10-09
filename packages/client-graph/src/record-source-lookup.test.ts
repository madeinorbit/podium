import { expect, it, vi } from 'vitest'
import { createKernelReplica, createSideCache } from '@podium/client-core/replica'
import { memoryStorage } from '@podium/client-core/replica'
import { InMemoryReplicaStore } from '../../sync/src/replica/memory-store'
import { Replica } from '../../sync/src/replica/replica'
import { ConformanceAuthority, conformanceUser, requireHuman } from '../../sync/src/conformance/authority'
import { createWorklistPool } from './create'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'
import { LOADING } from './loading'

/** Real authority visibility policy, kernel exits, client facade and row-source
 * wiring. The pool gets no fixture-owned exit ledger. No server process needed. */
it('server deletion and revoked visibility remain distinct through the replica and pool', async () => {
  const authority = new ConformanceAuthority()
  await authority.resolveIdentity()
  const principal = conformanceUser('lookup-user')
  const payload = (id: string) => ({
    id, seq: 1, title: id, stage: 'in_progress', repoPath: '/synthetic',
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z',
  })
  for (const id of ['deleted', 'private']) {
    authority.append({ entity: 'issueProjection', entityId: id, op: 'upsert', payload: payload(id) })
    authority.grant(requireHuman(principal), 'issueProjection', id)
  }
  const store = new InMemoryReplicaStore()
  const facade = createKernelReplica({
    cache: store.cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    exits: (entity, id) => replica.exitKind(entity, id),
  })
  const replica = new Replica({
    store: store.cache, authority: authority.portFor(principal),
    onEvent: event => facade.onKernelEvent(event),
    batchEvents: emit => facade.batch(emit),
  })
  replica.connect()
  await replica.settled()
  const rows = createRowSource({ onLocals: () => () => {}, readLocal: () => [], principal: { userId: 'lookup-user' } }, facade, { pending: { byRow: () => new Map() } })
  const locals = fixedLocals({ selectedIssueId: null, coarseNow: Date.parse('2026-10-09T00:00:00Z') })
  const schedule = vi.fn(() => () => {})
  const handle = createWorklistPool(rows.source, locals.source, { schedule })
  try {
    const from = authority.head()
    authority.append({ entity: 'issueProjection', entityId: 'deleted', op: 'remove' })
    authority.revoke(requireHuman(principal), 'issueProjection', 'private')
    await replica.receive(authority.frameFor(principal, from))
    await replica.settled()
    rows.flush()
    expect(replica.exitKind('issueProjection', 'deleted')).toBe('removed')
    expect(replica.exitKind('issueProjection', 'private')).toBe('evicted')
    expect(handle.pool.row('issue', 'deleted')).toEqual({ kind: 'gone', reason: 'removed' })
    expect(handle.pool.model('issue', 'deleted')).toEqual({ kind: 'gone', reason: 'removed' })
    expect(schedule).not.toHaveBeenCalled()
    expect(handle.pool.model('issue', 'private')).toBe(LOADING)
    expect(handle.pool.hydrate()).toBe(0)
    expect(handle.pool.model('issue', 'private')).toEqual({ kind: 'gone', reason: 'not-visible' })
    expect(handle.pool.row('issue', 'deleted')).not.toBe(LOADING)

    const readmit = authority.head()
    authority.grant(requireHuman(principal), 'issueProjection', 'private')
    await replica.receive(authority.frameFor(principal, readmit))
    await replica.settled()
    rows.flush()
    expect(replica.exitKind('issueProjection', 'private')).toBeUndefined()
    expect(handle.pool.model('issue', 'private')).toBe(handle.pool.issueObject('private'))
  } finally {
    handle.dispose(); rows.dispose(); locals.dispose(); replica.disconnect()
  }
})
