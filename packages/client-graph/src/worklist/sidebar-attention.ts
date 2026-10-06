import { keyedComputed } from '@podium/mobx-helpers'
import { cachedGroup } from '../cached'
import { debugName } from '../debug-name'
import { hostOf, type IssueModel, type SessionModel } from '../models'
import type { MobxPool } from '../pool'
import type { SliceSession } from '../shared/slice-types'
import { nestParentPartOf } from './visible'
import { aggregate, LOADING, ownAttentionPartOf, ownFactsOf, seatVerdictOf, type Aggregate } from './rollup'

/** Sidebar demand has its own computations: asking for a drawn row must not
 * first fill the entity's history-wide attention and nesting payloads. */
function memo<V>(name: string, read: (issue: IssueModel, pool: MobxPool) => V) {
  return keyedComputed<IssueModel, V, [MobxPool]>(
    issue => debugName(() => `IssueModel@${issue.id}.sidebar.${name}`), read,
    { context: issue => issue },
  )
}

const EMPTY_IDS: readonly string[] = Object.freeze([])

const nestParent = cachedGroup('sidebar.parent', (issue: IssueModel) =>
  nestParentPartOf(hostOf(issue).visibleInputs, issue.id, issue.nestCandidate))
const lanePath = cachedGroup('sidebar.lanePath', (issue: IssueModel) => issue.worktreePath)
const below: (issue: IssueModel, pool: MobxPool) => readonly string[] = memo('below', (issue, pool): readonly string[] => {
  const ids: string[] = []
  const host = hostOf(issue)
  for (const id of pool.graph.many('issue', issue.id, 'treeChildren')) {
    const child = host.visibleInputs.issue(id)
    if (!child) continue
    if (child.present) ids.push(id)
    else ids.push(...below(child as IssueModel, pool))
  }
  return ids.length === 0 ? EMPTY_IDS : ids.sort()
})

/** The candidate set excludes archived senders before any iteration. The
 * nesting rule's ownerOf rejects them, including archived non-exited seats.
 * Unarchived exited senders and issueless lane members still contribute. */
export const sidebarNested = memo('nested', (issue, pool): readonly string[] => {
  if (!issue.present) return EMPTY_IDS
  const host = hostOf(issue)
  const ids = new Set<string>()
  for (const id of below(issue, pool)) {
    const child = host.visibleInputs.issue(id)
    if (child && nestParent(child as IssueModel) === issue.id) ids.add(id)
  }
  const startedBy = (sessionId: string) => {
    for (const id of pool.graph.many('session', sessionId, 'startedIssues')) {
      const child = host.visibleInputs.issue(id)
      if (child && nestParent(child as IssueModel) === issue.id) ids.add(id)
    }
  }
  for (const sessionId of pool.queries.ids({ kind: 'commandIssueSessions', issueId: issue.id,
    archived: false, includeShells: true })) {
    // Each child's canonical parent checks R2 ownership, headless exclusion
    // and resume collapse. Empty started relations need no ownership probe.
    startedBy(sessionId)
  }
  if (lanePath(issue)) for (const sessionId of issue.laneMemberIds) {
      const session = host.visibleInputs.session(sessionId)
      if (session.retention !== null && !session.retention.archived) startedBy(sessionId)
    }
  return ids.size === 0 ? EMPTY_IDS : [...ids].sort()
})

const seat = cachedGroup('sidebar.seat', (session: SessionModel) => {
  const raw = hostOf(session).row('session', session.id)
  return raw === LOADING || raw === undefined ? raw : seatVerdictOf(raw as SliceSession)
})
const facts = memo('facts', issue => ownFactsOf(hostOf(issue).rollupInputs.loadedIssue(issue.id)))

export const sidebarOwnAttention = memo('own', (issue, pool) => {
  const host = hostOf(issue)
  return ownAttentionPartOf({ ...host.rollupInputs,
    seat: id => seat(host.visibleInputs.session(id) as SessionModel),
  }, {
    get present() { return issue.present },
    get ownFacts() { return facts(issue, pool) },
    get rosterIds() { return issue.rosterIds },
    get openOwn() { return issue.openOwn },
    get tip() { return issue.tip },
  })
})

export const sidebarAttention: (issue: IssueModel, pool: MobxPool) => Aggregate = memo('attention', (issue, pool): Aggregate => {
  const own = sidebarOwnAttention(issue, pool)
  const children: Aggregate[] = []
  if (!own.cold) for (const id of sidebarNested(issue, pool)) {
    const child = hostOf(issue).visibleInputs.issue(id)
    if (child) children.push(sidebarAttention(child as IssueModel, pool))
  }
  // Preserve roll-up order for the first error, timer ties and fleet glyphs.
  children.sort((a, b) => {
    const x = a.order, y = b.order
    if (!x || !y) return 0
    const keyed = Number(!x.sortKey) - Number(!y.sortKey)
    if (keyed) return keyed
    if (x.sortKey && y.sortKey && x.sortKey !== y.sortKey) return x.sortKey < y.sortKey ? -1 : 1
    return (Date.parse(y.createdAt) || 0) - (Date.parse(x.createdAt) || 0) || y.seq - x.seq || x.id.localeCompare(y.id)
  })
  return { ...aggregate({ own, children }), order: own.order }
})

/** A heartbeat changes a scalar, independent of the attention composition. */
export const sidebarSeatActivity: (issue: IssueModel, pool: MobxPool) => number | null = memo('activity', (issue, pool): number | null => {
  if (!issue.present || facts(issue, pool).state === 'cold') return null
  const host = hostOf(issue)
  let latest: number | null = null
  for (const id of issue.rosterIds) {
    const at = host.visibleInputs.session(id).activityMs
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  for (const id of sidebarNested(issue, pool)) {
    const child = host.visibleInputs.issue(id)
    const at = child ? sidebarSeatActivity(child as IssueModel, pool) : null
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  return latest
})

export const sidebarActivityAt = memo('activityAt', (issue, pool) => {
  const own = issue.ownActivityAt, seat = sidebarSeatActivity(issue, pool)
  return seat !== null && seat > own ? seat : own
})
