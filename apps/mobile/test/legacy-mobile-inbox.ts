// Frozen pre-migration answers for paired fixture comparisons. Never imported by product code.
import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { compareStructural, computed } from 'mobx'
import { issuePages } from '@podium/client-graph/issue-page'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING, type Loaded } from '@podium/client-graph/worklist/rollup'

type ScreeningSummary = Pick<
  IssueViewModel,
  | 'id'
  | 'stage'
  | 'parentId'
  | 'archived'
  | 'deletedAt'
  | 'isDraftVessel'
  | 'audience'
  | 'priority'
  | 'seq'
>
const isScreenableRoot = (issue: ScreeningSummary) =>
  issue.stage === 'proposed' &&
  !issue.archived &&
  !issue.deletedAt &&
  !issue.isDraftVessel &&
  issue.audience !== 'agent'
/** Order key for the queue: priority ascending, then newest first. Fixed-width
 * complements keep lexicographic order equal to the numeric sort, so the
 * keeper's tree maintains the queue order one changed key at a time. */
export const screeningOrderKey = (issue: ScreeningSummary) => {
  const priority = Math.trunc(issue.priority ?? 0) + 0x80000000
  const newestFirst = 0xffffffff - Math.max(0, Math.trunc(issue.seq ?? 0))
  return `${String(priority).padStart(10, '0')}:${String(newestFirst).padStart(10, '0')}`
}
interface ScreeningEntry {
  id: ScreeningSummary['id']
  key: string
}
/** One proposed issue's queue membership, read through its own summary plus
 * its ancestor chain. The keeper tracks exactly those rows, so an unrelated
 * proposal change never re-reads this entry. */
export function readScreeningEntry(pool: MobxPool, id: string): Loaded<ScreeningEntry> {
  const row = pool.row('issue', id, 'summary') as Loaded<ScreeningSummary>
  if (row === LOADING) return LOADING
  if (!row || !isScreenableRoot(row)) return undefined
  const seen = new Set<string>([row.id])
  let parentId = row.parentId,
    pending = false
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = pool.row('issue', parentId, 'summary') as Loaded<ScreeningSummary>
    if (parent === LOADING) {
      pending = true
      break
    }
    if (!parent) break
    if (parent.stage === 'proposed') return undefined
    parentId = parent.parentId
  }
  if (pending) return LOADING
  return { id: row.id, key: screeningOrderKey(row) }
}
/** Constructed only with the enabled attachment. Shared computed readers keep
 * callbacks and retained chips addressed to this pool and this principal. */
export function createMobileInboxViews(pool: MobxPool) {
  const booting = () => {
    const state = pool.row('mobileInboxState', 'state')
    return (
      !state ||
      state === LOADING ||
      (!state.hasCursor && pool.queries.count('session') === 0 && pool.queries.count('issue') === 0)
    )
  }
  const inbox = computed(
    () => {
      const sessions: SessionView[] = [],
        issues: Record<string, IssueViewModel> = {}
      let loading = booting()
      for (const id of pool.queries.ids({ kind: 'inboxSessions' })) {
        if (pool.queries.collapsed(id)) continue
        const summary = pool.row('session', id, 'summary') as Loaded<SessionView>
        if (summary === LOADING) {
          loading = true
          continue
        }
        if (!summary || summary.archived || summary.headless || summary.agentKind === 'shell')
          continue
        const session = pool.row('session', id) as Loaded<SessionView>
        if (session === LOADING) {
          loading = true
          continue
        }
        if (!session) continue
        sessions.push(session)
        const issueId = session.issueId
        if (issueId && !issues[issueId]) {
          const issue = issuePages(pool).issue(issueId)
          if (issue === LOADING) loading = true
          else if (issue) issues[issueId] = issue
        }
      }
      const window = pool.row('window', 'window') as { outboxSize: number } | undefined
      return {
        groups: groupSessions(withoutShells(sessions)),
        issues,
        booting: loading,
        outboxSize: window?.outboxSize ?? 0,
      }
    },
    { equals: compareStructural },
  )
  const screening = computed(
    () => {
      // Incremental eligible root IDs and order: the shared keeper maintains
      // one entry per proposed issue (its own summary plus its ancestor
      // chain) and publishes queue IDs through a persistent ordered tree. A
      // single proposal change re-reads only the changed keys; unchanged
      // rows share the previous branches and no proposal payload is
      // reprojected. The wrapper only re-derives the ordered ID list when
      // that maintained answer actually changes.
      const answers = pool.queries.project(
        { kind: 'proposedIssues' },
        'mobileInbox.screening',
        (id) => readScreeningEntry(pool, id),
      )
      const loading = booting() || answers === LOADING
      const queue =
        answers === LOADING || answers === undefined
          ? []
          : [...answers]
              .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1))
              .map((entry) => entry.id)
      return { queue, booting: loading }
    },
    { equals: compareStructural },
  )
  return { inbox: () => inbox.get(), screening: () => screening.get(), dispose() {} }
}
