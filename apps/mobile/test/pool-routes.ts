/** Fully resident synthetic address fixtures; route and chip outputs come from the production pool. */
import { createMobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import type { PodiumTarget } from '@podium/protocol'

interface AddressIssue {
  id: string
  seq?: number
  prefix?: string
  displayRef?: string
  title?: string
  stage?: string
}
export function poolRouteFixture(input: {
  issues: readonly AddressIssue[]
  sessions: readonly { sessionId: string; displayRef?: string }[]
}) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({
    type: 'replace',
    rows: [
      ...[...new Set(input.issues.flatMap((row) => row.prefix ? [row.prefix] : []))].map((prefix) => ({
        kind: 'worktree' as const, id: `/synthetic/${prefix}`, value: {
          path: `/synthetic/${prefix}`, repoId: prefix, prefix, repoPath: `/synthetic/${prefix}`, repoName: prefix,
        } as never,
      })),
      ...input.issues.map((row) => ({
        kind: 'issue' as const,
        id: row.id,
        value: {
          seq: 0,
          title: row.id,
          stage: 'backlog',
          archived: false,
          deps: [],
          repoPath: '/synthetic',
          createdAt: '',
          updatedAt: '',
          ...row,
          repoId: row.prefix,
        } as never,
      })),
      ...input.sessions.map((row) => ({
        kind: 'session' as const,
        id: row.sessionId,
        // Address fixtures declare identity only. A full SessionView may carry
        // resume-chain membership which belongs to a separate reader question.
        value: { sessionId: row.sessionId, displayRef: row.displayRef } as never,
      })),
    ],
  })
  pool.sources.register(['mobileInboxState'], {
    read: () => ({ hasCursor: true }),
    dispose() {},
  })
  const views = createMobileInboxViews(pool)
  return {
    pool,
    views,
    route(target: PodiumTarget): string | null {
      let route = views.route(target)
      if (route === LOADING && target.kind === 'issue') {
        // This fixture declares that every visible row is resident. A missing
        // identity query therefore has an authoritative empty answer.
        pool.references.resolved(target.issue, null)
        route = views.route(target)
      }
      if (route === LOADING) throw new Error('Resident address fixture unexpectedly cold')
      return route ?? null
    },
    dispose() {
      views.dispose()
      pool.dispose()
    },
  }
}
export function poolRoute(target: PodiumTarget, input: Parameters<typeof poolRouteFixture>[0]) {
  const fixture = poolRouteFixture(input)
  try {
    return fixture.route(target)
  } finally {
    fixture.dispose()
  }
}
