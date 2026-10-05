import { MobxPool } from '@podium/client-graph/pool'
import { expect, it, vi } from 'vitest'
import { readReferenceSession, readRefMiniview } from './ref-miniview-readers'

const stamp = '2026-10-05T00:00:00Z'
function fixture(size: number) {
  const issue = { id: 'own', seq: 1, title: 'Own card', repoId: 'repo', repoPath: '/synthetic', stage: 'in_progress',
    createdAt: stamp, updatedAt: stamp, parentId: 'parent' }
  const session = { sessionId: 'seat', issueId: 'parent', displayRef: 'POD-2-A', cwd: '/synthetic', agentKind: 'codex',
    status: 'live', createdAt: stamp, lastActiveAt: stamp }
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [
    { kind: 'worktree', id: '/synthetic', value: { path: '/synthetic', repoId: 'repo', repoPath: '/synthetic', prefix: 'POD', repoName: 'Synthetic' } },
    ...[issue, { ...issue, id: 'parent', seq: 2, parentId: undefined, coordinatorSessionId: 'seat' }].map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ...[session, { ...session, sessionId: 'headless', displayRef: 'POD-2-B', headless: true },
      { ...session, sessionId: 'dead', displayRef: 'POD-2-C', status: 'exited' },
      { ...session, sessionId: 'archived', archived: true },
      { ...session, sessionId: 'shell', agentKind: 'shell' }].map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
    ...Array.from({ length: size }, (_, i) => [
      { kind: 'issue' as const, id: `unrelated-${i}`, value: { ...issue, id: `unrelated-${i}`, seq: i + 10, parentId: undefined } },
      { kind: 'session' as const, id: `other-${i}`, value: { ...session, sessionId: `other-${i}`, issueId: `unrelated-${i}`, displayRef: `POD-${i+10}-A` } },
    ]).flat(),
  ] })
  return pool
}
it('addresses issue seats and nearest parent on first/repeated opens equally at 1x/4x history', () => {
  const work = []
  for (const size of [64, 256]) {
    const pool = fixture(size), row = vi.spyOn(pool, 'row')
    try {
      vi.spyOn(pool.tables.issue, 'keys').mockImplementation(() => { throw new Error('issue catalog') })
      vi.spyOn(pool.tables.session, 'keys').mockImplementation(() => { throw new Error('session catalog') })
      for (let n = 0; n < 2; n++) {
        row.mockClear()
        const card = readRefMiniview(pool, 'POD-1')
        expect(card.loading).toBe(false)
        expect(card.issues.map(issue => issue.id)).toEqual(['own', 'parent'])
        expect(card.sessions.map(seat => seat.sessionId)).toEqual(['seat', 'headless'])
        expect(row.mock.calls.some(([, id]) => id.startsWith('unrelated-') || id.startsWith('other-'))).toBe(false)
        work.push(row.mock.calls.length)
      }
      row.mockClear()
      expect(readReferenceSession(pool, 'POD-2-A')).toMatchObject({ sessionId: 'seat' })
      expect(row.mock.calls.filter(([kind]) => kind === 'session')).toEqual([['session', 'seat', 'summary-fields']])
      expect(readReferenceSession(pool, 'POD-99999-A')).toBeUndefined()
    } finally { pool.dispose(); vi.restoreAllMocks() }
  }
  expect(work[2]).toBe(work[0]); expect(work[3]).toBe(work[1])
  console.info('POD-5569 reference row reads [1x first,repeat;4x first,repeat]', work)
})
