/** Synthetic, private rows for the real sidebar and StoreProvider. No network
 * connection, operator cache, export, or second runtime is used by this fixture. */
import type { PodiumClientApi } from '@podium/client-core/api'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { machineAndRepoRecords } from '@podium/client-core/test-support/machine-records'
import {
  asIssueId,
  asSessionId,
  asUserId,
  issueUserStateRowId,
  pinRowId,
  sessionUserStateRowId,
} from '@podium/model'
import type { EntityRecord } from '@podium/sync/replica'

export function createSidebarFixture(
  count = 18,
  now = Date.now(),
  simple = false,
  userId = 'operator',
) {
  const iso = (offset: number) => new Date(now + offset).toISOString()
  const records = new Map<string, EntityRecord>()
  const put = (entity: string, entityId: string, value: unknown) => {
    const record = { entity, entityId, value, provenance: { seq: 1 } }
    records.set(`${entity}:${entityId}`, record)
    return record
  }
  const repos = [
    {
      path: '/synthetic/project',
      repoId: 'synthetic-repo',
      kind: 'repository',
      branch: 'main',
      worktrees: !simple ? [{ path: '/synthetic/project/guests', branch: 'guests' }] : [],
    },
    ...(!simple
      ? [
          {
            path: '/synthetic/empty',
            repoId: 'empty-repo',
            kind: 'repository',
            branch: 'main',
            worktrees: [],
          },
        ]
      : []),
  ]
  // The registered repositories and their worktrees are checkout records (POD-6644).
  for (const record of machineAndRepoRecords({ userId, repos: repos as never }))
    put(record.entity, record.entityId, record.value)
  for (const repo of repos)
    put('repo', repo.repoId, {
      id: repo.repoId,
      repoPath: repo.path,
      prefix: 'SYN',
      name: repo.path.split('/').at(-1),
    })
  for (let i = 0; i < count; i += 1) {
    const id = `synthetic-${i}`
    const issue = {
      id,
      seq: 1000 + i,
      repoId: 'synthetic-repo',
      repoPath: '/synthetic/project',
      title: i === count - 1 ? 'Only responsive target' : `Synthetic task ${i}`,
      description: '',
      stage: !simple && i === 5 ? 'done' : 'in_progress',
      worktreePath: '/synthetic/project',
      branch: 'main',
      parentBranch: 'main',
      defaultAgent: 'codex',
      blockedByNotes: [],
      createdAt: iso(-86400000),
      updatedAt: iso(-3600000),
      archived: false,
      needsHuman: false,
      intentOrigin: 'human',
      audience: 'human',
      isDraftVessel: false,
      priority: 2,
      type: 'task',
      pinned: !simple && i === 0,
      labels: [],
      readAt: iso(-3600000),
      ...(!simple && i === 2 ? { deferUntil: iso(3600000) } : {}),
      ...(!simple && i === 5
        ? { closedAt: iso(-600000), tuckedAt: iso(-300000), closedReason: 'done' }
        : {}),
      ...(!simple && (i === 3 || i === 4) ? { parentId: 'synthetic-1' } : {}),
    }
    const { readAt, tuckedAt, pinned, repoPath, ...normalized } = issue
    put('issueUserState', issueUserStateRowId(asUserId(userId), asIssueId(id)), {
      userId,
      entityId: id,
      readAt,
      tuckedAt: tuckedAt ?? null,
    })
    // A pinned task is my pin record (POD-6692), never a marker.
    if (pinned) {
      put('pin', pinRowId(asUserId(userId), 'issue', id), {
        userId,
        kind: 'issue',
        entityId: id,
        pinnedAt: iso(-86400000),
      })
    }
    put('issueProjection', id, {
      ...normalized,
      description: { value: '' },
      intentOrigin: 'human',
      isDraftVessel: false,
    })
    put('session', `synthetic-session-${i}`, {
      sessionId: `synthetic-session-${i}`,
      agentKind: 'codex',
      issueId: id,
      cwd: '/synthetic/project',
      title: `Synthetic agent ${i}`,
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: iso(-86400000),
      lastActiveAt: iso(-3600000),
      origin: { kind: 'spawn' },
      archived: false,
      busy: false,
      readAt: iso(-3600000),
      agentState: { phase: 'idle', since: iso(-3600000), idle: { kind: 'done' } },
    })
  }
  if (!simple)
    for (let i = 0; i < 2; i += 1) {
      const sessionId = `synthetic-guest-${i}`
      put('session', sessionId, {
        ...(records.get('session:synthetic-session-0')!.value as object),
        sessionId,
        issueId: undefined,
        cwd: '/synthetic/project/guests',
        title: `Synthetic guest ${i}`,
      })
      put('sessionUserState', sessionUserStateRowId(asUserId(userId), asSessionId(sessionId)), {
        userId,
        sessionId,
        readAt: null,
      })
    }
  let replica = makeReplica()
  function makeReplica() {
    // The synthetic kernel owns exit evidence, just as the real kernel does.
    const exits = new Map<string, 'evicted' | 'removed'>()
    const result = createKernelReplica({
      exits: (entity, id) => exits.get(`${entity}:${id}`),
      cache: {
        readCursor: () => null,
        readEntities: () => [...records.values()],
        read: (entity, id) => records.get(`${entity}:${id}`),
        durability: () => 'durable',
      },
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    const deliver = result.onKernelEvent.bind(result)
    return Object.assign(result, { onKernelEvent(event: Parameters<typeof deliver>[0]) {
      if (event.type === 'removed' || event.type === 'evicted') exits.set(`${event.entity}:${event.entityId}`, event.type)
      if (event.type === 'upserted') exits.delete(`${event.record.entity}:${event.record.entityId}`)
      if (event.type === 'bootstrap-installed') exits.clear()
      deliver(event)
    } })
  }
  const api = {
    settings: { get: { query: async () => ({ sessionDefaults: { agent: 'codex' } }) } },
    features: { state: { query: async () => ({ devMode: true, channel: 'edge', flags: [] }) } },
  } as unknown as PodiumClientApi
  return {
    api,
    records,
    get replica() {
      return replica
    },
    newReplica() {
      replica = makeReplica()
      return replica
    },
    patch(entity: string, id: string, patch: Record<string, unknown>) {
      const current = records.get(`${entity}:${id}`)
      if (!current) throw new Error(`Unknown synthetic ${entity}:${id}`)
      const record = put(entity, id, { ...(current.value as object), ...patch })
      replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
    },
    /**
     * Machines and repositories as their synced records (POD-6644): each
     * machine's record and my access row, each repository's checkouts. A
     * repository the input no longer lists loses its checkout records.
     */
    putMachinesAndRepos(input: {
      machines?: readonly ({ id: string } & Record<string, unknown>)[]
      repos?: readonly ({ path: string; kind: string } & Record<string, unknown>)[]
    }) {
      const nextRecords = machineAndRepoRecords({ userId, ...input } as never)
      const kept = new Set(nextRecords.map((next) => `${next.entity}:${next.entityId}`))
      if (input.machines)
        for (const [key, record] of records)
          if ((record.entity === 'machine' || record.entity === 'machineAccess') && !kept.has(key)) {
            records.delete(key)
            replica.onKernelEvent({ type: 'removed', entity: record.entity, entityId: record.entityId })
          }
      if (input.repos)
        for (const [key, record] of records)
          if (record.entity === 'checkout' && !kept.has(key)) {
            records.delete(key)
            replica.onKernelEvent({ type: 'removed', entity: 'checkout', entityId: record.entityId })
          }
      for (const next of nextRecords) {
        const record = put(next.entity, next.entityId, next.value)
        replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
      }
    },
    /** Pin or unpin a task for the fixture's user: its `pin` record (POD-6692). */
    pinIssue(id: string, pinned: boolean) {
      const pinId = pinRowId(asUserId(userId), 'issue', id)
      if (pinned) {
        const record = put('pin', pinId, {
          userId,
          kind: 'issue',
          entityId: id,
          pinnedAt: iso(-86400000),
        })
        replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
        return
      }
      if (!records.delete(`pin:${pinId}`)) return
      replica.onKernelEvent({ type: 'removed', entity: 'pin', entityId: pinId })
    },
  }
}
