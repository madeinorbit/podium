import type { IssueViewModel } from '@podium/client-core/replica'
import { resolveIssueEdge } from '@podium/client-core/values'
import type { PageIssue } from '@podium/client-graph/issue-page'
import { readPageIssue } from '@podium/client-graph/issue-page'
import { issueTargets } from '@podium/client-graph/issue-targets'
import { omitGone } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { useCallback } from 'react'
import { useIssueOpening } from './issue-opening'
import { useMobilePoolProjection } from './mobile-pool'

/** Resolve only the shared issue identity. Sections read their own fields. */
export function useIssueModel(id: string | undefined) {
  const read = useCallback((pool: MobxPool) => (id ? readPageIssue(pool, id) : undefined), [id])
  const issue = useMobilePoolProjection(read, undefined)
  return typeof issue === 'symbol' ? undefined : issue
}

/**
 * Where the issue's lookup stands, as the desktop's three answers: here, on
 * its way (`loading`, or `offline` when no load can start), or gone (deleted
 * or not visible). Reading it holds and loads the record like the model read.
 */
export type IssueReading = 'here' | 'refreshing' | 'loading' | 'offline' | 'gone'
export function useIssueReading(id: string | undefined): IssueReading {
  const read = useCallback(
    (pool: MobxPool): IssueReading =>
      id ? pool.collections.reading(pool.row('issue', id)) : 'gone',
    [id],
  )
  return useMobilePoolProjection(read, 'loading')
}

/** The overflow needs only existence. Target payloads are read when a target
 * picker actually opens, using the already declared repository question. */
export function useHasIssueMates(issue: IssueViewModel, enabled: boolean) {
  const views = useIssueOpening()
  const read = useCallback(
    () => enabled && (views?.row(issue.id).hasTargets ?? false),
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
      return issueTargets(pool, issue, query, limit)
    },
    [issue, enabled, query, limit],
  )
  return useMobilePoolProjection(read, null)
}

export function resolveEdgeFromPool(pool: MobxPool | null, id: string | undefined | null) {
  return resolveIssueEdge(
    id,
    (targetId) => {
      const raw = omitGone(pool?.row('issue', targetId))
      return raw && typeof raw !== 'symbol' ? (pool!.issueObject(targetId) as PageIssue) : undefined
    },
    'opaque',
    (targetId) => pool?.issueObject(targetId).exitKind,
  )
}
