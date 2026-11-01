/** POD-2315: a closed task whose parent was deleted or archived draws as a
 * root row. It must fold into Closed like a closed top-level issue, instead
 * of sitting in the open lane forever because it still names a parent. */
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'
import { worklistView } from './view-model'

const now = '2026-10-05T12:00:00Z'
const old = '2026-10-03T12:00:00Z'
const recent = '2026-10-05T11:00:00Z'
const pools: MobxPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
})

type Row = { kind: 'issue' | 'session' | 'worktree'; id: string; value: unknown }
const task = (id: string, patch: object = {}): Row => ({
  kind: 'issue',
  id,
  value: {
    id,
    seq: 1,
    title: id,
    stage: 'in_progress',
    audience: 'human',
    repoId: 'alpha',
    repoPath: '/code/alpha',
    createdAt: old,
    updatedAt: old,
    deps: [],
    ...patch,
  },
})
// A parked agent seat keeps its finished task drawn, as on the live sidebar.
const session = (id: string, issueId: string): Row => ({
  kind: 'session',
  id,
  value: {
    sessionId: id,
    issueId,
    cwd: '/code/alpha',
    agentKind: 'codex',
    status: 'hibernated',
    archived: false,
    lastActiveAt: old,
    agentState: { phase: 'idle', since: old, idle: { kind: 'done' } },
  },
})
const closed = (at = old) => ({ stage: 'done', closedReason: 'done', closedAt: at, updatedAt: at })
const repo: Row = {
  kind: 'worktree',
  id: '/code/alpha',
  value: {
    path: '/code/alpha',
    repoPath: '/code/alpha',
    repoId: 'alpha',
    repoName: 'alpha',
    isMain: true,
    projectIndex: 0,
    projectRoot: true,
  },
}

function poolWith(rows: Row[]): MobxPool {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(now) })
  pools.push(pool)
  pool.apply({ type: 'replace', rows: rows as never })
  return pool
}
const lanes = (pool: MobxPool) => {
  const [band] = worklistView(pool).sections().bands
  return { open: [...(band?.rowIds ?? [])], closed: [...(band?.closedIds ?? [])] }
}
const children = (): Row[] => [
  task('agent-child', { ...closed(), audience: 'agent', parentId: 'parent' }),
  session('s1', 'agent-child'),
  task('human-child', { ...closed(), parentId: 'parent' }),
  session('s2', 'human-child'),
  task('tucked-child', { ...closed(), audience: 'agent', parentId: 'parent', tuckedAt: old }),
  session('s3', 'tucked-child'),
]

describe('closed tasks of a removed parent', () => {
  for (const removed of [{ deletedAt: old }, { archived: true }]) {
    it(`fold into Closed when the parent is ${Object.keys(removed)[0]}`, () => {
      const pool = poolWith([repo, task('parent', removed), ...children()])
      expect(lanes(pool)).toEqual({
        open: [],
        closed: expect.arrayContaining(['agent-child', 'human-child', 'tucked-child']),
      })
    })
  }

  it('stay open through the finished grace like any closed root', () => {
    const pool = poolWith([
      repo,
      task('parent', { deletedAt: old }),
      task('fresh', { ...closed(recent), audience: 'agent', parentId: 'parent' }),
      session('s1', 'fresh'),
    ])
    expect(lanes(pool)).toEqual({ open: ['fresh'], closed: [] })
  })

  it('nest again, not as root rows, once the parent is restored', () => {
    const pool = poolWith([repo, task('parent', { deletedAt: old }), ...children()])
    expect(lanes(pool).closed).toHaveLength(3)
    runInAction(() =>
      pool.apply({ type: 'update', rows: [task('parent', { deletedAt: null })] as never }),
    )
    expect(lanes(pool)).toEqual({ open: ['parent'], closed: [] })
  })
})
