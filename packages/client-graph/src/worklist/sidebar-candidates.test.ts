/**
 * POD-7148 — the sidebar's filing candidates (`SIDEBAR_CANDIDATES`): only an
 * issue the sidebar can show files a row, whatever collection brought it to
 * the device. The risky seam: issues the sidebar shows that the sidebar
 * collection (open, not proposed) never holds, because they reach the device
 * through another collection (recent, or a session's comes-with).
 */
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'
import { sidebarNested, sidebarView } from './sidebar'
import { isSidebarCandidate, sidebarKeeperOf } from './visible'

const stamp = '2026-10-05T12:00:00Z'
/** Finished a day before `stamp`: inside every finished-row window. */
const yesterday = '2026-10-04T12:00:00Z'
const pools: MobxPool[] = []
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose()
})

type Row = { kind: 'issue' | 'session' | 'worktree'; id: string; value: unknown }
const root: Row = {
  kind: 'worktree',
  id: '/code/alpha',
  value: {
    path: '/code/alpha',
    repoPath: '/code/alpha',
    repoId: 'alpha',
    repoName: 'Repo alpha',
    isMain: true,
    projectIndex: 0,
    projectRoot: true,
  },
}
const issue = (id: string, patch: object = {}): Row => ({
  kind: 'issue',
  id,
  value: {
    id,
    seq: Number(id.replace(/\D/g, '')) || 1,
    title: id,
    stage: 'in_progress',
    closedReason: null,
    archived: false,
    deletedAt: null,
    audience: 'human',
    repoId: 'alpha',
    repoPath: '/code/alpha',
    createdAt: stamp,
    updatedAt: stamp,
    deps: [],
    ...patch,
  },
})
const closedAgentTask = (id: string, patch: object = {}) =>
  issue(id, {
    stage: 'done',
    closedReason: 'completed',
    closedAt: yesterday,
    updatedAt: yesterday,
    audience: 'agent',
    parentId: 'open-1',
    ...patch,
  })
const session = (id: string, issueId: string | null, patch: object = {}): Row => ({
  kind: 'session',
  id,
  value: {
    sessionId: id,
    issueId,
    cwd: '/code/alpha',
    agentKind: 'codex',
    status: 'live',
    archived: false,
    lastActiveAt: stamp,
    agentState: { phase: 'needs_user', since: stamp },
    ...patch,
  },
})

function poolWith(rows: Row[]): MobxPool {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pools.push(pool)
  runInAction(() => pool.apply({ type: 'replace', rows: [root, ...rows] as never }))
  return pool
}
const update = (pool: MobxPool, rows: Row[]) =>
  runInAction(() => pool.apply({ type: 'update', rows: rows as never }))
/** Every row the sidebar draws, open and closed, nested ones included. */
function shown(pool: MobxPool): string[] {
  const ids = new Set<string>()
  for (const band of sidebarView(pool).sections({}).bands)
    for (const id of [...band.rowIds, ...band.snoozedIds, ...band.closedIds]) ids.add(id)
  // A nested row's descendants come with it (`visibleDescendantIds`).
  for (const id of [...ids]) {
    const row = pool.worklistRow(id)
    if (row) for (const child of sidebarNested(row, pool)) ids.add(child)
  }
  return [...ids].sort()
}

describe('the declared candidates, by row', () => {
  it('takes open issues and the finished rows the sidebar keeps, and nothing that cannot show', () => {
    const value = (patch: object) => issue('x', patch).value as never
    expect(isSidebarCandidate(value({}))).toBe(true)
    expect(isSidebarCandidate(value({ stage: 'backlog', audience: 'agent' }))).toBe(true)
    // The closed fold and a finished child's window: human.
    expect(isSidebarCandidate(value({ stage: 'done', closedReason: 'completed' }))).toBe(true)
    expect(isSidebarCandidate(value({ stage: 'review', closedReason: 'cancelled' }))).toBe(true)
    // Awaiting merge: a private branch keeps a finished agent row.
    expect(isSidebarCandidate(value({ stage: 'done', audience: 'agent', branch: 'issue/1' }))).toBe(
      true,
    )
    // Never shown: a finished agent task, proposed, system custody, archived, deleted.
    expect(isSidebarCandidate(value({ stage: 'done', audience: 'agent' }))).toBe(false)
    expect(isSidebarCandidate(value({ stage: 'proposed' }))).toBe(false)
    expect(isSidebarCandidate(value({ stage: 'shipping' }))).toBe(false)
    expect(isSidebarCandidate(value({ archived: true }))).toBe(false)
    expect(isSidebarCandidate(value({ deletedAt: stamp }))).toBe(false)
    expect(
      isSidebarCandidate(value({ stage: 'done', closedReason: 'completed', archived: true })),
    ).toBe(false)
  })

  it('reads a seat as a keeper of its issue, never a shell, an archived session or one with no issue', () => {
    const value = (issueId: string | null, patch: object = {}) =>
      session('s', issueId, patch).value as never
    expect(sidebarKeeperOf(value('t'))).toBe('t')
    expect(sidebarKeeperOf(value('t', { status: 'exited' }))).toBe('t')
    expect(sidebarKeeperOf(value('t', { agentKind: 'shell' }))).toBeUndefined()
    expect(sidebarKeeperOf(value('t', { archived: true }))).toBeUndefined()
    expect(sidebarKeeperOf(value(null))).toBeUndefined()
    expect(sidebarKeeperOf(undefined)).toBeUndefined()
  })
})

describe('the pool files only candidates', () => {
  it('leaves an issue that can never show out of the filing, whatever brought it', () => {
    const pool = poolWith([
      issue('open-1'),
      issue('proposed-2', { stage: 'proposed' }),
      // Done agent tasks a tree or a page brought: no seat keeps them.
      closedAgentTask('done-3'),
      closedAgentTask('done-4', { parentId: null }),
    ])
    expect(pool.worklist.tracks('open-1')).toBe(true)
    expect(pool.worklist.tracks('proposed-2')).toBe(false)
    expect(pool.worklist.tracks('done-3')).toBe(false)
    expect(pool.worklist.tracks('done-4')).toBe(false)
    expect(shown(pool)).toEqual(['open-1'])
  })

  it('shows a closed issue that reaches the device only as a waiting session comes with it', () => {
    // The asking session (session.asking) brings its issue along (its declared
    // comes-with); the sidebar collection never holds a closed issue.
    const pool = poolWith([
      issue('open-1'),
      closedAgentTask('kept-5'),
      session('asking-1', 'kept-5'),
    ])
    expect(pool.worklist.tracks('kept-5')).toBe(true)
    expect(shown(pool)).toContain('kept-5')
    // Archiving the only seat releases the issue; it leaves the sidebar.
    update(pool, [session('asking-1', 'kept-5', { archived: true })])
    expect(pool.worklist.tracks('kept-5')).toBe(false)
    expect(shown(pool)).not.toContain('kept-5')
    // A seat back on it takes it again.
    update(pool, [session('asking-1', 'kept-5')])
    expect(pool.worklist.tracks('kept-5')).toBe(true)
    expect(shown(pool)).toContain('kept-5')
  })

  it('takes a session-kept issue whichever of the two arrives first, and lets go when the seat moves', () => {
    const pool = poolWith([issue('open-1'), session('live-1', 'kept-6')])
    update(pool, [closedAgentTask('kept-6')])
    expect(pool.worklist.tracks('kept-6')).toBe(true)
    expect(shown(pool)).toContain('kept-6')
    update(pool, [session('live-1', 'open-1')])
    expect(pool.worklist.tracks('kept-6')).toBe(false)
    expect(shown(pool)).not.toContain('kept-6')
    // The issue leaving the device and coming back keeps its answer.
    update(pool, [session('live-1', 'kept-6'), { kind: 'issue', id: 'kept-6', value: undefined }])
    expect(pool.worklist.tracks('kept-6')).toBe(false)
    update(pool, [closedAgentTask('kept-6')])
    expect(pool.worklist.tracks('kept-6')).toBe(true)
  })

  it('shows recently finished human rows that only the recent collection brings', () => {
    const pool = poolWith([
      issue('open-1'),
      // A closed top-level human issue: the closed fold.
      issue('fold-7', {
        stage: 'done',
        closedReason: 'completed',
        closedAt: yesterday,
        updatedAt: yesterday,
      }),
      // A finished human child inside its window.
      issue('child-8', {
        stage: 'done',
        closedReason: 'completed',
        closedAt: yesterday,
        updatedAt: yesterday,
        parentId: 'open-1',
      }),
    ])
    expect(pool.worklist.tracks('fold-7')).toBe(true)
    expect(pool.worklist.tracks('child-8')).toBe(true)
    expect(shown(pool)).toEqual(['child-8', 'fold-7', 'open-1'])
  })

  it('judges a row again when it changes: a reopened task files, a proposal that is accepted files', () => {
    const pool = poolWith([
      issue('open-1'),
      closedAgentTask('done-3'),
      issue('proposed-2', { stage: 'proposed' }),
    ])
    update(pool, [
      closedAgentTask('done-3', { stage: 'in_progress', closedReason: null, closedAt: null }),
      issue('proposed-2', { stage: 'in_progress' }),
    ])
    expect(pool.worklist.tracks('done-3')).toBe(true)
    expect(pool.worklist.tracks('proposed-2')).toBe(true)
    // The rule still decides: the accepted human issue shows; the reopened
    // agent task, with no seat on it, is a candidate the rule drops.
    expect(shown(pool)).toEqual(['open-1', 'proposed-2'])
    update(pool, [
      issue('open-1', {
        stage: 'done',
        closedReason: 'completed',
        audience: 'agent',
        parentId: 'x',
      }),
    ])
    expect(pool.worklist.tracks('open-1')).toBe(false)
  })
})
