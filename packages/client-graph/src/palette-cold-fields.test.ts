import { runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { COMMAND_SUMMARIES } from './command-launch-schema'
import { commandIssueSearchRef, commandLaunchViews, createCommandPalette } from './command-launch-views'
import { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

it('matches legacy search fields for cold palette issues without loading their payloads', () => {
  const stamp = '2020-01-01T00:00:00Z'
  const issues = Array.from({ length: 24 }, (_, seq) => ({
    id: `history-${seq}`, seq, title: `Historical task ${seq}`, repoId: 'project',
    stage: 'done', audience: 'human', archived: false, isDraftVessel: false,
    createdAt: stamp, updatedAt: stamp, closedAt: stamp,
  }))
  const load = vi.fn((_kind: string, id: string) => issues.find(issue => issue.id === id))
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-09') },
    undefined, { load, summaries: COMMAND_SUMMARIES, schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [
    { kind: 'repo', id: 'project', value: { id: 'project', prefix: 'POD', repoPath: '/project' } as never },
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value: value as never })),
  ] })
  pool.sources.register(['commandCatalog', 'commandWindow', 'commandIssue'], {
    read: (entity, id) => entity === 'commandCatalog'
      ? { issues: issues.map(issue => issue.id), sessions: [], repositories: [], repos: [], worktrees: [], machines: [] }
      : entity === 'commandIssue' ? pool.row('issue', id, 'summary')
      : { paletteOpen: true, pins: { repos: [], worktrees: [] }, selectedIssueId: null,
          openIssueId: null, selectedWorktree: null, paneA: null, recentFiles: [], sidebarSettings: {} } as never,
    dispose() {},
  })
  const picker = createCommandPalette(pool)
  try {
    runInAction(() => {
      const old = commandLaunchViews(pool).palette()
      picker.open()
      const current = picker.palette()
      if (!old || old === LOADING || !current || current === LOADING) throw new Error('Palette did not settle')
      expect(pool.tables.issue.size).toBe(0)
      for (const expected of old.issues) {
        const issue = current.issues.find(issue => issue.id === expected.id)!
        expect({ title: issue.title, stage: issue.stage, displayRef: commandIssueSearchRef(issue) })
          .toEqual({ title: expected.title, stage: expected.stage, displayRef: expected.displayRef })
      }
      expect(pool.hydrate()).toBe(0)
      expect(load).not.toHaveBeenCalled()
    })
  } finally { picker.close(); pool.dispose() }
})
