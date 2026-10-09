import { requireHere } from './lookup'
import { sidebarRosterView } from './worklist/sidebar-roster'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { worklistView } from './worklist/view-model'

it('keeps a missing cold seat out of the roster without indexing or loading its row', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  const path = '/synthetic/cold-roster'
  const session = { sessionId: 'cold-seat', cwd: path, issueId: null, agentKind: 'codex',
    title: 'Historical seat', status: 'exited', archived: false,
    lastActiveAt: '2026-01-01T00:00:00Z', stoppedAt: '2026-01-01T00:00:00Z' }
  const load = vi.fn(() => session)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: now }, undefined,
    { load, schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [
    { kind: 'worktree', id: path, value: { path, repoPath: path, repoName: 'Synthetic', projectIndex: 0 } },
    { kind: 'session', id: session.sessionId, value: session as never },
  ] })
  const missing = vi.spyOn(pool.residency!, 'summary').mockReturnValue(undefined)
  const tree = worklistView(pool).tree(requireHere(pool.model('worktree', path))!)
  try {
    expect(pool.tables.session.has(session.sessionId)).toBe(false)
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: session.sessionId, value: { ...session, title: 'Changed' } as never }] })
    expect(sidebarRosterView(pool).candidates(path)).toEqual([])
    // POD-5407: the roster files resident sessions only. A session the rule
    // keeps cold can never be a retained seat, so a missing cold summary
    // stays pending 0 and queues no load.
    expect(tree.roster).toEqual({ ids: [], pending: 0 })
    expect(tree.roster).toEqual({ ids: [], pending: 0 })
    expect(load).not.toHaveBeenCalled()
    missing.mockRestore()
    expect(pool.hydrate()).toBe(0)
    expect(load).not.toHaveBeenCalled()
    expect(tree.roster).toEqual({ ids: [], pending: 0 })
    expect(pool.hydrate()).toBe(0)
  } finally { missing.mockRestore(); pool.dispose() }
})
