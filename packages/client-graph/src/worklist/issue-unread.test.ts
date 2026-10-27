import { describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'

const stamp = '2026-10-08T12:00:00Z'
const issue = (id: string, patch: object = {}) => ({ id, seq: 1, title: id,
  stage: 'planning', audience: 'human', repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, ...patch })
const session = (id: string, owner: string, patch: object = {}) => ({ sessionId: id, issueId: owner,
  cwd: '/synthetic', agentKind: 'codex', status: 'live', archived: false, lastActiveAt: stamp,
  agentState: { phase: 'working', since: stamp }, ...patch })

it('an until-next-message issue is deferred and is not ready on the shared model', () => {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: 'root', value: issue('root', { deferUntil: 'next-message' }) as never },
    { kind: 'session', id: 'seat', value: session('seat', 'root') as never },
  ] })
  const model = pool.issueObject('root')
  try { expect(model.deferred).toBe(true); expect(model.ready).toBe(false) }
  finally { pool.dispose() }
})

describe('the shared replica unread answer', () => {
  const cursor = '2026-10-08T12:00:00Z'
  const earlier = '2026-10-08T11:00:00Z'
  const later = '2026-10-08T13:00:00Z'
  for (const [name, patch, member, expected] of [
    ['never read', {}, undefined, true],
    ['already read', { readAt: cursor, updatedAt: earlier }, undefined, false],
    ['new issue edit', { readAt: cursor, updatedAt: later }, undefined, true],
    ['archived member activity', { readAt: cursor, updatedAt: earlier }, { archived: true, agentKind: 'codex' }, true],
    ['member without replica timestamp', { readAt: cursor, updatedAt: earlier }, { archived: true, agentKind: 'codex' }, true],
    ['shell activity', { readAt: cursor, updatedAt: earlier }, { archived: true, agentKind: 'shell' }, false],
    ['deleted', { deletedAt: later }, undefined, false],
    ['cold read', { stage: 'done', closedAt: earlier, updatedAt: earlier, readAt: cursor }, undefined, false],
  ] as const) it(name, () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined,
      name === 'cold read' ? { load: () => undefined, schedule: () => () => {} } : undefined)
    if (name === 'member without replica timestamp') {
      const fact = pool.issueSessionFact.bind(pool)
      Object.defineProperty(pool, 'issueSessionFact', { value: (id: string, key: Parameters<typeof fact>[1]) =>
        key === 'replicaActivityAt' ? undefined : fact(id, key) })
    }
    pool.apply({ type: 'replace', rows: [
      { kind: 'issue', id: 'root', value: issue('root', patch) as never },
      ...(member ? [{ kind: 'session' as const, id: 'member', value: session('member', 'root', { ...member, lastActiveAt: later }) as never }] : []),
    ] })
    try { expect(pool.issueObject('root').unread).toBe(expected) }
    finally { pool.dispose() }
  })
})
