import { createIssueMentionIndex } from '@podium/client-graph/shared/issue-mention-question'
import { expect, it } from 'vitest'
import { issueMentions } from '@/lib/at-mention/mention-sources'
import { makeIssue } from '@/lib/test-issue'

it('preserves mention ranking and eligibility across source edits, Unicode, refs and empty recency windows', () => {
  const index = createIssueMentionIndex()
  let rows = [
    makeIssue({ id: 'first', seq: 412, title: 'Composer context picker', updatedAt: '2026-10-01T00:00:00Z', repoId: 'repo', displayRef: 'POD-412' }),
    makeIssue({ id: 'second', seq: 42, title: 'Recompute the sheet', updatedAt: '2026-10-02T00:00:00Z', repoId: 'repo', displayRef: 'POD-42' }),
    makeIssue({ id: 'third', seq: 413, title: 'Fix Composer', updatedAt: '2026-10-03T00:00:00Z', repoId: 'repo', displayRef: 'POD-413', linearIdentifier: 'EXT-17' }),
    makeIssue({ id: 'unicode', seq: 500, title: 'Café [editor]', repoId: 'repo', displayRef: 'POD-500' }),
    makeIssue({ id: 'archived', seq: 501, title: 'Composer', archived: true, repoId: 'repo', displayRef: 'POD-501' }),
  ]
  const check = () => {
    for (const q of ['', 'comp', 'context', 'POD', 'OD-', 'pod-4', '412', '17', 'EXT', 'café', '[editor]', 'missing'])
      expect(index.ids({ kind: 'issueMentionMatches', query: q, limit: 5, prefixes: { repo: 'POD' } }))
        .toEqual(issueMentions(rows.filter(row => !row.deletedAt), q, 5).map(option => option.id.slice(6)))
  }
  for (const row of rows) index.set(row.id, row)
  check()
  rows = rows.map(row => row.id === 'first' ? { ...row, title: 'Changed', archived: true } : row)
  index.set(rows[0]!.id, rows[0]); check()
  index.set('second', undefined); rows = rows.filter(row => row.id !== 'second'); check()
})
it('bounds ranked IDs and source candidate visits for empty/rare/missing mentions at 1x/4x history', () => {
  const work = []
  for (const size of [64, 256]) {
    const index = createIssueMentionIndex()
    for (let i = 0; i < size; i++) index.set(`other-${i}`, { seq: i, title: 'Unrelated issue', repoId: 'repo', updatedAt: '2020-01-01T00:00:00Z' })
    for (let i = 0; i < 8; i++) index.set(`own-${i}`, { seq: i + 1000, title: 'Unique exact match', repoId: 'repo', updatedAt: '2026-01-01T00:00:00Z' })
    for (const query of ['', 'unique', 'absent', 'POD-100']) {
      const before = index.counts.visits
      const ids = index.ids({ kind: 'issueMentionMatches', query, limit: 5, prefixes: { repo: 'POD' } })
      expect(ids.length).toBeLessThanOrEqual(5)
      work.push(index.counts.visits - before)
    }
  }
  expect(work.slice(4)).toEqual(work.slice(0, 4))
})
