import { expect, it, vi } from 'vitest'
import { missionIndexStats } from '@podium/client-core/viewmodels'
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
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: root.id, value: root }, { kind: 'issue', id: spin.id, value: spin },
    { kind: 'session', id: sender.sessionId, value: sender }, { kind: 'session', id: pane.sessionId, value: pane },
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
    work.selectIssue('root')
    expect(store.navigateWorkspace).toHaveBeenLastCalledWith({ selectedIssueId: 'root', tabId: 'pane', firstPane: true })
    expect(store.markIssueRead).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledWith('root')
    expect(missions(pool).stats).toEqual(before)
    expect(missionIndexStats()).toEqual(legacy)
  } finally { row.mockRestore(); pool.dispose() }
})
