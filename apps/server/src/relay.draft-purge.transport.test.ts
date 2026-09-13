import { ISSUE_PRIVATE_EXECUTION_KEYS, firstAdminMemberId } from '@podium/model'
import type { FeedChange, ServerMessage } from '@podium/protocol'
import { InMemoryReplicaStore, Replica, type ChangeEnvelope } from '@podium/sync/replica'
import { expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { attachTestClient } from './test-support/client-transport'
import { openTestStore } from './test-support/open-test-store'

const envelope = (change: FeedChange): ChangeEnvelope => ({
  seq: change.seq, entity: change.entity, entityId: change.entityId, op: change.op,
  ...(change.op === 'upsert' ? { payload: change.value } : {}),
})

// No later issue write may heal the purge. A rollback must retain the cache.
it.each([false, true])('purge replaces the owner replica after commit (outer span: %s)', async (outerSpan) => {
  const store = await openTestStore(':memory:')
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'draft-purge' })
  const cache = new InMemoryReplicaStore()
  const frames: ServerMessage[] = []
  const deliveries: Promise<unknown>[] = []
  let clientId: string | undefined
  let replica: Replica
  let bootstraps = 0
  try {
    const { sessionId } = await registry.modules.sessions.createSession({
      ownerUserId: firstAdminMemberId(), agentKind: 'codex', cwd: '/repo',
    })
    const draft = await registry.issues.create({
      repoPath: '/repo', title: 'abandoned draft', draft: true, startNow: false,
      ownerUserId: firstAdminMemberId(), startedBySession: sessionId,
    })
    await registry.issues.update(draft.id, {
      worktreePath: '/repo/.worktrees/abandoned', coordinatorSessionId: sessionId,
    })
    registry.modules.funnel.flushDeltas()

    replica = new Replica({
      store: cache.cache,
      unitOfWork: cache.unitOfWork,
      authority: {
        changesSince: async () => { throw new Error('purge must rebootstrap without a later write') },
        async *bootstrap() {
          bootstraps++
          if (clientId) registry.clientGateway.detachClient(clientId)
          const inbox: ServerMessage[] = []
          clientId = attachTestClient(registry.clientGateway, {
            userId: firstAdminMemberId(), userRole: 'admin',
            send: (message) => {
              frames.push(message)
              inbox.push(message)
              if (message.type === 'feedRescope') {
                deliveries.push(replica.receive({ ...message, kind: 'rescope' }))
              } else if (message.type === 'feedDelta') {
                deliveries.push(replica.receive({
                  ...message, kind: 'delta', changes: message.changes.map(envelope),
                }))
              }
            },
          })
          await registry.clientGateway.routeClientFrame(clientId, {
            type: 'hello', wireVersion: 2, clientId: '',
            viewport: { cols: 80, rows: 24, dpr: 1 },
          })
          await expect.poll(() => inbox.some((m) => m.type === 'feedBootstrap' && m.last)).toBe(true)
          for (const message of inbox) {
            if (message.type === 'feedBootstrap') yield {
              feedId: message.feedId, epoch: message.epoch, snapshotSeq: message.seq,
              last: message.last, changes: message.changes.map(envelope),
            }
          }
        },
      },
    })
    replica.connect()
    await replica.settled()
    const kinds = ['issue', 'issueProjection', 'issueExecution']
    expect(cache.cache.readEntities().filter((r) => r.entityId === draft.id).map((r) => r.entity).sort())
      .toEqual([...kinds].sort())
    const execution = cache.cache.read('issueExecution', draft.id)?.value
    expect(execution).toMatchObject({ worktreePath: '/repo/.worktrees/abandoned', machineId: store.hostMachineId })
    for (const key of ISSUE_PRIVATE_EXECUTION_KEYS) expect(execution).toHaveProperty(key)
    expect(cache.cache.read('session', sessionId)).toBeDefined()
    expect(bootstraps).toBe(1)
    frames.length = 0

    if (outerSpan) {
      await expect(store.transact(async () => {
        await registry.issues.purgeEmptyDraft(draft.id)
        throw new Error('roll back purge')
      })).rejects.toThrow('roll back purge')
      registry.modules.funnel.flushDeltas()
      expect(frames.some((m) => m.type === 'feedRescope')).toBe(false)
      for (const kind of kinds) expect(cache.cache.read(kind, draft.id)).toBeDefined()
      await store.transact(async () => { await registry.issues.purgeEmptyDraft(draft.id) })
    } else {
      await registry.issues.purgeEmptyDraft(draft.id)
    }
    registry.modules.funnel.flushDeltas()
    await expect.poll(() => frames.some((m) => m.type === 'feedRescope')).toBe(true)
    await Promise.all(deliveries)
    await replica.settled()
    expect(bootstraps).toBeGreaterThan(1)
    expect(frames.some((m) => m.type === 'feedBootstrap' && m.last)).toBe(true)
    expect(cache.cache.read('session', sessionId)).toBeDefined()
    expect(await store.issues.getIssue(draft.id)).toBeNull()
    for (const kind of kinds) expect(cache.cache.read(kind, draft.id)).toBeUndefined()
    expect(frames.filter((m) => m.type === 'feedBootstrap').flatMap((m) => m.changes)
      .some((change) => change.entityId === draft.id)).toBe(false)
    expect(JSON.stringify(frames.filter((m) => m.type === 'feedRescope'))).not.toContain(draft.id)
  } finally {
    if (clientId) registry.clientGateway.detachClient(clientId)
    await registry.dispose()
    await store.close()
  }
})
