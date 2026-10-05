import { MobxPool } from '@podium/client-graph/pool'
import { expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { readIssueMenuChoices, readIssueMenuOrigins } from './issue-menu-readers'

it('requests no choice catalog for main, status or colour controls at 1x/4x history', () => {
  for (const size of [64, 256]) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
    const subject = makeIssue({ parentId: 'parent' }), parent = makeIssue({ id: 'parent', title: 'Origin' })
    pool.apply({ type: 'replace', rows: [parent, subject, ...Array.from({ length: size }, (_, i) => makeIssue({ id: `other-${i}` }))]
      .map(value => ({ kind: 'issue', id: value.id, value })) })
    const ids = vi.spyOn(pool.queries, 'ids'), row = vi.spyOn(pool, 'row')
    try {
      for (const kind of [undefined, 'status', 'color', 'handoff'] as const) {
        expect(readIssueMenuChoices(pool, kind)).toBeUndefined()
        expect(ids).not.toHaveBeenCalled(); expect(row).not.toHaveBeenCalled()
      }
      expect(readIssueMenuOrigins(pool, [subject]).map(issue => issue.id)).toEqual([subject.id, 'parent'])
      expect(row.mock.calls.filter(([kind]) => kind === 'issue').every(([, id]) => id === 'parent')).toBe(true)
      expect(ids).not.toHaveBeenCalled()
      readIssueMenuChoices(pool, 'duplicate')
      expect(ids).toHaveBeenCalledWith({ kind: 'pageIssues' })
    } finally { pool.dispose(); vi.restoreAllMocks() }
  }
})
