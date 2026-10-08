import type { SessionModel } from './models'
import type { SessionView } from '@podium/client-core/session-values'
import type { PageIssue } from './issue-page'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { LOADING } from './worklist/rollup'

/** Only existing seats leave the list; their installed fields use the view's wire types. */
export type DetailSession = SessionModel & SessionView

/** These are data-layer query results of model identities. Display-only field
 * changes are read by the row observers and do not replace a roster. */
export function createIssueDetailLists(issue: PageIssue, pool: MobxPool) {
  const child = createQueryResult<PageIssue>({
    name: `IssueDetail@children:${issue.id}`,
    ids: () => pool.graph.many('issue', issue.id, 'treeChildren'),
    has: (id) => pool.queries.hasMember('issue', issue.id, 'treeChildren', id),
    order: (id) => {
      const row = pool.row('issue', id, 'summary-fields') as
        | { seq?: number }
        | typeof LOADING
        | undefined
      return row === LOADING ? '' : String(row?.seq ?? 0).padStart(12, '0')
    },
    read: (id) => {
      const row = pool.row('issue', id, 'summary-fields') as
        | { deletedAt?: string }
        | typeof LOADING
        | undefined
      return row === LOADING
        ? LOADING
        : row && !row.deletedAt
          ? (pool.issueObject(id) as PageIssue)
          : undefined
    },
    subscribe: (changed) => pool.queries.onMembers('issue', issue.id, 'treeChildren', changed),
  })
  const seats = (
    name: string,
    relation: 'pageSessions' | 'missionSessions' | 'bornSessions',
    archived: boolean | undefined,
    keep: (session: SessionModel) => boolean,
    order?: (session: SessionModel) => string,
  ) =>
    createQueryResult<DetailSession>({
      name: `IssueDetail@${name}:${issue.id}`,
      ids: () =>
        archived === false && relation !== 'bornSessions'
          ? pool.graph.subset('issue', issue.id, relation, 'unarchived')
          : pool.graph.many('issue', issue.id, relation),
      has: (id) =>
        pool.queries.hasMember('issue', issue.id, relation, id) &&
        (archived !== false || pool.queries.sessionStoredField(id, 'archived') !== true),
      ...(order
        ? {
            order: (id: string) => {
              const session = pool.sessionObject(id)
              try {
                return archived !== undefined && session.archived !== archived ? id : order(session)
              } catch (error) {
                if (error === LOADING) return id
                throw error
              }
            },
          }
        : {}),
      read: (id) => {
        const session = pool.sessionObject(id)
        try {
          return (archived === undefined || session.archived === archived) &&
            session.exists &&
            !pool.queries.collapsed(id) &&
            keep(session)
            ? (session as DetailSession)
            : undefined
        } catch (error) {
          if (error === LOADING) return LOADING
          throw error
        }
      },
      subscribe: (changed) => {
        const stopMembers = pool.queries.onMembers('issue', issue.id, relation, changed)
        // A previously hidden archived seat is not subscribed by the query.
        // Feed deltas admit it when it joins the declared live subset.
        const stopRows =
          archived === false
            ? pool.queries.onChange((event) => {
                if (event.type === 'replace') return
                for (const row of event.rows)
                  if (
                    row.kind === 'session' &&
                    pool.queries.hasMember('issue', issue.id, relation, row.id)
                  )
                    changed(row.id)
              })
            : undefined
        return () => {
          stopMembers()
          stopRows?.()
        }
      },
    })
  const members = seats('members', 'pageSessions', undefined, () => true)
  const liveMembers = seats('live-members', 'pageSessions', false, () => true)
  const active = seats(
    'active',
    'pageSessions',
    false,
    (session) => session.open,
    (session) =>
      `${session.asking ? '0' : '1'}|${session.sessionId === issue.coordinatorSessionId ? '0' : '1'}|${String(9e15 - (session.activityMs ?? 0)).padStart(16, '0')}`,
  )
  const retired = seats('retired', 'pageSessions', undefined, (session) => !session.open)
  // The dock includes explicitly attached shells; raw page membership excludes them.
  const dockActive = seats(
    'dock-active',
    'missionSessions',
    false,
    (session) => session.open,
    (session) =>
      `${session.asking ? '0' : '1'}|${session.sessionId === issue.coordinatorSessionId ? '0' : '1'}|${String(9e15 - (session.activityMs ?? 0)).padStart(16, '0')}`,
  )
  const dockRetired = seats(
    'dock-retired',
    'missionSessions',
    undefined,
    (session) => !session.open,
    (session) => pool.queries.orderKey(session.sessionId),
  )
  const moved = seats(
    'moved',
    'bornSessions',
    false,
    (session) => Boolean(session.issueId && session.issueId !== issue.id),
    (session) => pool.queries.orderKey(session.sessionId),
  )
  const phone = seats(
    'phone',
    'missionSessions',
    false,
    () => true,
    (session) => pool.queries.orderKey(session.sessionId),
  )
  const inspector = seats(
    'inspector',
    'missionSessions',
    false,
    (session) => session.agentKind !== 'shell',
    (session) =>
      `${session.asking ? '0' : '1'}|${String(9e15 - (session.activityMs ?? 0)).padStart(16, '0')}`,
  )
  return {
    children: child,
    members,
    liveMembers,
    active,
    retired,
    dockActive,
    dockRetired,
    moved,
    phone,
    inspector,
    dispose() {
      for (const list of [
        child,
        members,
        liveMembers,
        active,
        retired,
        dockActive,
        dockRetired,
        moved,
        phone,
        inspector,
      ])
        list.dispose()
    },
  }
}
