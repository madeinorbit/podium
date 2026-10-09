import { omitGone } from './lookup'
import { observable, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { createCommandPalette } from './command-launch-views'
import { MobxPool } from './pool'

it('preserves the opening member order for every addressed issue, then renews it on reopen', () => {
  const selected = observable.map<string, string | null>([['id', null]])
  const stamp = '2026-10-09T12:00:00Z'
  const ids = ['z', 'a', 'A', 'aa', 'Å', 'empty']
  const issues = ids.map((id, seq) => ({ id, seq, title: id, stage: 'backlog',
    repoPath: '/checkout', createdAt: stamp, updatedAt: stamp }))
  const sessions = ['z', 'a', 'Å', 'A', 'z', 'aa', 'a', '', 'z'].map((issueId, index) => ({
    sessionId: `session-${index}`, issueId, agentKind: index === 8 ? 'shell' : 'codex',
    status: 'live', cwd: '/checkout', archived: false, lastActiveAt: stamp,
  }))
  // Independent old filter: input order, membership, and shell exclusion.
  const oldMembers = (issueId: string | null) => sessions
    .filter(session => session.issueId && session.agentKind !== 'shell' && session.issueId === issueId)
    .map(session => session.sessionId)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value: value as never })),
    ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value: value as never })),
  ] })
  pool.sources.register(['commandCatalog', 'commandWindow', 'commandIssue'], {
    read: (entity, id) => entity === 'commandCatalog'
      ? { issues: ids, sessions: sessions.map(session => session.sessionId), repositories: [], repos: [], worktrees: [], machines: [] }
      : entity === 'commandIssue' ? omitGone(pool.row('issue', id)) as never
      : { paletteOpen: true, pins: { repos: [], worktrees: [] }, selectedIssueId: selected.get('id') ?? null,
          openIssueId: null, selectedWorktree: null, paneA: null, recentFiles: [], sidebarSettings: {} } as never,
    dispose() {},
  })
  const picker = createCommandPalette(pool)
  const parity = () => runInAction(() => {
    for (const id of [null, 'missing', ...ids]) {
      selected.set('id', id)
      expect(picker.memberIds, String(id)).toEqual(oldMembers(id))
    }
  })
  try {
    runInAction(() => picker.open())
    parity()
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'session-0',
      value: { ...sessions[0], issueId: 'a' } as never }] })
    parity() // An open palette keeps its captured membership.
    sessions[0]!.issueId = 'a'
    runInAction(() => picker.open())
    parity()
    runInAction(() => picker.close())
    expect(picker.memberOrder).toEqual([])
    expect(picker.issuePositions.size).toBe(0)
    expect(picker.memberPositions.size).toBe(0)
  } finally { picker.close(); pool.dispose() }
})
