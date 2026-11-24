import { expect, it } from 'vitest'
import { createMobileInboxViews } from './mobile-inbox-views'
import { MobxPool } from './pool'

it('opens an exited session ref through the same indexed identity as desktop', () => {
  const pool = new MobxPool({ selectedIssueId: null })
  pool.apply({
    type: 'replace',
    rows: [
      { kind: 'repo', id: 'project', value: { id: 'project', prefix: 'MRD', repoPath: '/repo' } },
      {
        kind: 'session',
        id: 'exited',
        value: {
          sessionId: 'exited',
          status: 'exited',
          archived: true,
          cwd: '/repo',
          agentKind: 'claude-code',
          transcriptAvailable: true,
          refRepoId: 'project',
          refSeq: 5,
          refLetter: 'A',
        },
      },
    ] as never,
  })
  const views = createMobileInboxViews(pool)
  try {
    expect(pool.queries.linkedSessionId('MRD-5-A')).toBe('exited')
    expect(views.resolveRoute({ kind: 'session', session: 'MRD-5-A' })).toBe('/session/exited')
    expect(views.session('MRD-5-A')).toMatchObject({ status: 'exited', transcriptAvailable: true })
    expect(views.resolveRoute({ kind: 'session', session: 'exited' })).toBe('/session/exited')
    expect(views.resolveRoute({ kind: 'session', session: 'MRD-999-A' })).toBeNull()
  } finally {
    views.dispose()
    pool.dispose()
  }
})
