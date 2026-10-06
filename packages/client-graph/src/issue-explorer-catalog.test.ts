import { autorun } from 'mobx'
import { expect, it, vi } from 'vitest'
import { issuePages } from './issue-page'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'
import { LOADING } from './worklist/rollup'

it('retains catalog values and snapshots while updates read only the changed session at 1x/4x', () => {
  const reads: number[] = []
  for (const scale of [1, 4]) {
    const issue = (id: string, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
      id, seq: 1, title: id, repoPath: '/explorer', stage: 'planning', labels: [], deps: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch,
    } }) as RowRecord
    const seat = (id: string, patch: object = {}): RowRecord => ({ kind: 'session', id, value: {
      sessionId: id, issueId: 'parent', cwd: '/explorer', title: id, agentKind: 'codex',
      status: 'running', archived: false, lastActiveAt: 1, ...patch,
    } }) as RowRecord
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    pool.apply({ type: 'replace', rows: [issue('parent'), issue('child', { parentId: 'parent' }),
      ...Array.from({ length: 128 * scale }, (_, n) => seat(`seat-${n}`))] })
    const views = issuePages(pool)
    let catalog: ReturnType<typeof views.explorer>
    const stop = autorun(() => { catalog = views.explorer() })
    const spy = vi.spyOn(pool, 'row')
    try {
      if (!catalog || catalog === LOADING) throw new Error('Catalog is loading')
      expect([...catalog.issues]).toEqual(views.menuIssues())
      expect(catalog.sessions).toHaveLength(128 * scale)
      const before = catalog
      spy.mockClear()
      pool.apply({ type: 'update', rows: [seat('seat-0', { title: 'Renamed session' })] })
      const sessionReads = spy.mock.calls.filter(([kind]) => kind === 'session')
      expect(new Set(sessionReads.map(([, id]) => id))).toEqual(new Set(['seat-0']))
      expect(sessionReads.length).toBeLessThanOrEqual(8)
      reads.push(sessionReads.length)
      expect(catalog.issues).toBe(before.issues)
      expect(catalog.sessions.find(value => value.sessionId === 'seat-0')?.title).toBe('Renamed session')
      expect(before.sessions.find(value => value.sessionId === 'seat-0')?.title).toBe('seat-0')
      const members = catalog.issues.find(value => value.id === 'parent')!.memberSessionIds
      pool.apply({ type: 'update', rows: [issue('parent', { stage: 'review' })] })
      expect(catalog.issues.find(value => value.id === 'parent')!.memberSessionIds).toBe(members)
      pool.apply({ type: 'replace', rows: [issue('replacement')] })
      expect(catalog).toMatchObject({ sessions: [], issues: [{ id: 'replacement' }] })
    } finally { spy.mockRestore(); stop(); views.dispose(); pool.dispose() }
  }
  expect(reads[1]).toBe(reads[0])
})
