import { expect, it, vi } from 'vitest'
import { missionIndexStats } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph/pool'
import { missions } from '@podium/client-graph/mission'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { createPoolWorkActions } from './use-pool-unified-work'

it('selects a spin-off pane through the cached mission with zero legacy mission work', () => {
  const stamp = '2026-10-01T12:00:00Z'
  const root = { id: 'root', seq: 1, title: 'Synthetic root', stage: 'backlog', repoPath: '/synthetic',
    createdAt: stamp, updatedAt: stamp } satisfies SliceIssue
  const spin = { ...root, id: 'spin', startedBySession: 'headless', deps: [{ type: 'discovered-from', id: 'root' }] }
  const sender = { sessionId: 'headless', issueId: 'root', headless: true, cwd: '/synthetic', status: 'live',
    agentKind: 'codex', createdAt: stamp, lastActiveAt: stamp } satisfies SliceSession
  const pane = { ...sender, sessionId: 'pane', issueId: 'spin', headless: false }
  const unrelated = { ...root, id: 'unrelated' }
  const unrelatedPane = { ...pane, sessionId: 'unrelated-pane', issueId: unrelated.id }
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: root.id, value: root }, { kind: 'issue', id: spin.id, value: spin },
    { kind: 'issue', id: unrelated.id, value: unrelated },
    { kind: 'session', id: sender.sessionId, value: sender }, { kind: 'session', id: pane.sessionId, value: pane },
    { kind: 'session', id: unrelatedPane.sessionId, value: unrelatedPane },
  ] })
  const row = vi.spyOn(pool.sidebar, 'row').mockReturnValue({ issue: root, unsnoozed: false } as NonNullable<Exclude<ReturnType<typeof pool.sidebar.row>, symbol>>)
  const store = { paneA: null, fileTabs: [], batchGesture: (fn: () => void) => fn(),
    navigateWorkspace: vi.fn(() => false), markIssueRead: vi.fn(async () => {}) }
  const runtime = { getSnapshot: () => store } as unknown as Parameters<typeof createPoolWorkActions>[1]
  const focus = vi.fn()
  try {
    const work = createPoolWorkActions(pool, runtime, focus)
    const legacy = missionIndexStats()
    work.selectIssue('root')
    const before = { ...missions(pool).stats }
    const reads = vi.spyOn(pool, 'row')
    work.selectIssue('root')
    expect(store.navigateWorkspace).toHaveBeenLastCalledWith({ selectedIssueId: 'root', tabId: 'pane', firstPane: true })
    expect(store.markIssueRead).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledWith('root')
    expect(missions(pool).stats).toEqual(before)
    expect(missionIndexStats()).toEqual(legacy)
    expect(reads.mock.calls.filter(([entity]) => entity === 'session').map(([, id]) => id)).toEqual(['pane'])
    reads.mockRestore()
  } finally { row.mockRestore(); pool.dispose() }
})

it('keeps issue and session slice order for tied panes after relation buckets move', () => {
  const stamp = '2026-10-01T12:00:00Z'
  const root = { id: 'root', seq: 1, title: 'Synthetic root', stage: 'backlog', repoPath: '/synthetic',
    createdAt: stamp, updatedAt: stamp } satisfies SliceIssue
  const first = { ...root, id: 'first', parentId: root.id }
  const second = { ...root, id: 'second', parentId: root.id }
  const older = { sessionId: 'older', issueId: first.id, cwd: '/synthetic', status: 'live',
    agentKind: 'codex', createdAt: stamp, lastActiveAt: stamp } satisfies SliceSession
  const newer = { ...older, sessionId: 'newer' }
  const other = { ...older, sessionId: 'other', issueId: second.id }
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  const store = { paneA: null, fileTabs: [], batchGesture: (fn: () => void) => fn(),
    navigateWorkspace: vi.fn(() => false), markIssueRead: vi.fn(async () => {}) }
  const runtime = { getSnapshot: () => store } as unknown as Parameters<typeof createPoolWorkActions>[1]
  try {
    pool.apply({ type: 'replace', rows: [
      ...[root, first, second].map(value => ({ kind: 'issue' as const, id: value.id, value })),
      ...[older, newer, other].map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
    ] })
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: older.sessionId, value: { ...older, issueId: second.id } }] })
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: older.sessionId, value: older }] })
    const row = vi.spyOn(pool.sidebar, 'row').mockReturnValue({ issue: root, unsnoozed: false } as NonNullable<Exclude<ReturnType<typeof pool.sidebar.row>, symbol>>)
    try {
      const work = createPoolWorkActions(pool, runtime, vi.fn())
      work.selectIssue(root.id)
      expect(store.navigateWorkspace).toHaveBeenLastCalledWith({ selectedIssueId: root.id, tabId: older.sessionId, firstPane: true })
    } finally { row.mockRestore() }
  } finally { pool.dispose() }
})
