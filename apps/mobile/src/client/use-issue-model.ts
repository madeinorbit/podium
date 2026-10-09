import { omitGone } from '@podium/client-graph/lookup'
import { resolveIssueEdge } from '@podium/client-core/values'
import type { PageIssue } from '@podium/client-graph/issue-page'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { ReferentExit } from '@podium/client-core/values'
import { readPageIssue } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useCallback } from 'react'
import { useIssueOpening } from './issue-opening'
import { useMobilePoolProjection } from './mobile-pool'

/** Resolve only the shared issue identity. Sections read their own fields. */
export function useIssueModel(id: string | undefined) {
  const read = useCallback((pool: MobxPool) => (id ? readPageIssue(pool, id) : undefined), [id])
  const issue = useMobilePoolProjection(read, undefined)
  return typeof issue === 'symbol' ? undefined : issue
}

/** The overflow needs only existence. Target payloads are read when a target
 * picker actually opens, using the already declared repository question. */
export function useHasIssueMates(issue: IssueViewModel, enabled: boolean) {
  const views = useIssueOpening()
  const read = useCallback(
    (pool: MobxPool) => enabled && (views?.row(issue.id).hasTargets ?? false),
    [issue, enabled, views],
  )
  return useMobilePoolProjection(read, false)
}
const NO_TARGETS: string[] = []
export function useIssueTargets(
  issue: IssueViewModel,
  enabled: boolean,
  query: string,
  limit: number,
) {
  const read = useCallback(
    (pool: MobxPool): string[] | null => {
      if (!enabled) return NO_TARGETS
      const prefixes: Record<string, string | undefined> = {}
      for (const id of pool.queries.repoIds(issue.repoPath)) {
        const repo = omitGone(pool.row('repo', id)) as
          | { prefix?: string }
          | typeof LOADING
          | undefined
        if (repo === LOADING) return null
        prefixes[id] = repo?.prefix
      }
      return pool.queries.ids({
        kind: 'mobileIssueTargets',
        repoPath: issue.repoPath,
        excludeId: issue.id,
        query,
        limit,
        prefixes,
      })
    },
    [issue, enabled, query, limit],
  )
  return useMobilePoolProjection(read, null)
}

export function resolveEdgeFromPool(pool: MobxPool | null, id: string | undefined | null) {
  return resolveIssueEdge(
    id,
    (targetId) => {
      const raw = omitGone(pool?.row('issue', targetId, 'summary-fields'))
      return raw && typeof raw !== 'symbol' ? (pool!.issueObject(targetId) as PageIssue) : undefined
    },
    'opaque',
    (targetId) => pool?.issueObject(targetId).exitKind,
  )
}
