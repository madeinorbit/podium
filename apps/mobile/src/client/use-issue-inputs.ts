import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { ReferentExit } from '@podium/client-core/viewmodels'
import { issuePages } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useCallback } from 'react'
import { useMobilePoolProjection } from './mobile-pool'

interface IssueInputs {
  children: IssueViewModel[]
  parent: IssueViewModel | undefined
  issues: IssueViewModel[]
  sessions: SessionView[]
  exits: Readonly<Record<string, ReferentExit | undefined>>
}
/** This page, its children and its displayed edges. The picker catalog is a
 * separate demand; opening a task never materializes the issue/session world. */
function readIssueInputs(pool: MobxPool, issue: IssueViewModel): IssueInputs | null {
  const pages = issuePages(pool)
  const children: IssueViewModel[] = [], issues: IssueViewModel[] = [issue]
  const sessions = new Map<string, SessionView>()
  const exits: Record<string, ReferentExit | undefined> = {}
  let pending = false
  const members = (id: string) => {
    const rows = pages.attachedSessions(id)
    if (rows === LOADING) pending = true
    else for (const row of rows ?? []) sessions.set(row.sessionId, row)
  }
  members(issue.id)
  for (const id of pool.graph.many('issue', issue.id, 'treeChildren')) {
    const child = pages.issue(id)
    members(id)
    if (child === LOADING) pending = true
    else if (child && !child.deletedAt) { children.push(child); issues.push(child) }
  }
  children.sort((a, b) => a.seq - b.seq)
  const neighbours = new Set([
    issue.parentId, issue.supersededBy, issue.duplicateOf,
    ...issue.deps.map(edge => edge.id), ...issue.dependents.map(edge => edge.id),
  ].filter((id): id is NonNullable<typeof id> => Boolean(id)))
  let parent: IssueViewModel | undefined
  for (const id of neighbours) {
    const row = pages.summary(id)
    if (row === LOADING) pending = true
    else if (row) { issues.push(row); if (id === issue.parentId) parent = row }
    else {
      const exit = pool.row('issueExit', id)
      if (exit === LOADING) pending = true
      else exits[id] = exit?.kind
    }
  }
  return pending ? null : { children, parent, issues, sessions: [...sessions.values()], exits }
}
export function useIssueInputs(issue: IssueViewModel) {
  const read = useCallback((pool: MobxPool) => readIssueInputs(pool, issue), [issue])
  return useMobilePoolProjection(read, null)
}

function mateIds(pool: MobxPool, issue: IssueViewModel) {
  return pool.queries.ids({ kind: 'boardIssues', projectPaths: [issue.repoPath], archived: true, deleted: false })
    .filter(id => id !== issue.id)
}
/** The overflow needs only existence. Target payloads are read when a target
 * picker actually opens, using the already declared repository question. */
export function useHasIssueMates(issue: IssueViewModel, enabled: boolean) {
  const read = useCallback((pool: MobxPool) => enabled && mateIds(pool, issue).length > 0, [issue, enabled])
  return useMobilePoolProjection(read, false)
}
const NO_TARGETS: IssueViewModel[] = []
export function useIssueTargets(issue: IssueViewModel, enabled: boolean) {
  const read = useCallback((pool: MobxPool): IssueViewModel[] | null => {
    if (!enabled) return NO_TARGETS
    const targets: IssueViewModel[] = []
    let pending = false
    for (const id of mateIds(pool, issue)) {
      const target = issuePages(pool).summary(id)
      if (target === LOADING) pending = true
      else if (target) targets.push(target)
    }
    return pending ? null : targets.sort((a, b) => b.seq - a.seq)
  }, [issue, enabled])
  return useMobilePoolProjection(read, null)
}
