import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { IssueReferenceModel } from '@podium/client-core/values'
import type { PodiumTarget } from '@podium/protocol'
import { parseSessionRef } from '@podium/protocol'
import { compareStructural, computed, reaction } from 'mobx'
import { issuePages } from './issue-page'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

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
const screeningOrderKey = (issue: ScreeningSummary) => {
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
function readScreeningEntry(pool: MobxPool, id: string): Loaded<ScreeningEntry> {
  const row = pool.row('issue', id, 'summary') as Loaded<ScreeningSummary>
  if (row === LOADING || !row || !isScreenableRoot(row)) return row
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
  const waits = new Set<() => void>()
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
        answers === LOADING
          ? []
          : [...answers]
              .sort(
                (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1),
              )
              .map((entry) => entry.id)
      return { queue, booting: loading }
    },
    { equals: compareStructural },
  )
  function screeningRows(ids: readonly string[]) {
    const issues: Record<string, IssueViewModel> = {}
    let loading = false
    for (const id of ids) {
      if (!id || issues[id]) continue
      const issue = issuePages(pool).issue(id)
      if (issue === LOADING) {
        loading = true
        continue
      }
      if (!issue) continue
      issues[id] = issue
      if (issue.parentId) {
        const parent = issuePages(pool).issue(issue.parentId)
        if (parent === LOADING) loading = true
        else if (parent) issues[parent.id] = parent
      }
    }
    return { issues, loading }
  }
  function chip(token: string, refKind: 'issue' | 'session', prefix: string) {
    const known = pool.queries.hasIssuePrefix(prefix, true)
    const model = known && refKind === 'issue' ? pool.references.read(token) : null
    const unavailable: IssueReferenceModel | null = known && refKind === 'issue' ? {
      ref: token.trim(), issueId: null, title: null, stage: null,
      availability: 'unavailable', accessibleLabel: `Task ${token.trim()} is unavailable`,
    } : null
    return {
      known,
      model: model === LOADING ? unavailable : (model ?? unavailable),
      pending: model === LOADING,
    }
  }
  function session(identifier: string): Loaded<SessionView> {
    const trimmed = identifier.trim()
    const direct = pool.row('session', trimmed, 'summary') as Loaded<SessionView>
    if (direct && direct !== LOADING && !pool.queries.collapsed(trimmed)) return direct
    if (!parseSessionRef(trimmed)) return direct === LOADING ? LOADING : undefined
    let pending = false
    // Reference membership is indexed by the feed; rows still use one reader.
    const ids = pool.queries.ids({ kind: 'sessionReference', ref: trimmed }).sort((a, b) =>
      pool.queries.orderKey(a).localeCompare(pool.queries.orderKey(b)),
    )
    for (const id of ids) {
      if (pool.queries.collapsed(id)) continue
      const row = pool.row('session', id, 'summary') as Loaded<SessionView>
      if (row === LOADING) pending = true
      else if (row?.displayRef === trimmed) return row
    }
    return pending ? LOADING : undefined
  }
  function route(target: PodiumTarget): Loaded<string | null> {
    if ((target.kind !== 'issue' && target.kind !== 'session') || target.search || target.hash)
      return null
    if (target.kind === 'session') {
      const row = session(target.session)
      return row === LOADING
        ? LOADING
        : row
          ? `/session/${encodeURIComponent(row.sessionId)}`
          : null
    }
    const direct = pool.row('issue', target.issue.trim(), 'summary') as Loaded<{ id: string }>
    if (direct && direct !== LOADING) return `/issue/${encodeURIComponent(direct.id)}`
    // Bare aliases match the displayed fallback literally. Unlike PREFIX-N,
    // the legacy route does not parse a zero-padded bare sequence number.
    if (/^#0\d+$/.test(target.issue.trim())) return null
    const id = pool.references.id(target.issue)
    return id === LOADING ? LOADING : id ? `/issue/${encodeURIComponent(id)}` : null
  }
  function resolveRoute(target: PodiumTarget): string | null | Promise<string | null> {
    const current = route(target)
    if (current !== LOADING) return current ?? null
    return new Promise((resolve) => {
      let stop: (() => void) | undefined,
        finished = false
      const finish = (value: string | null) => {
        finished = true
        stop?.()
        waits.delete(cancel)
        resolve(value)
      }
      const cancel = () => finish(null)
      waits.add(cancel)
      stop = reaction(
        () => route(target),
        (value) => {
          if (value !== LOADING) finish(value ?? null)
        },
        { fireImmediately: true },
      )
      if (finished) stop()
    })
  }
  return {
    inbox: () => inbox.get(),
    screening: () => screening.get(),
    screeningRows,
    chip,
    route,
    resolveRoute,
    booting,
    session,
    dispose() {
      for (const cancel of [...waits]) cancel()
    },
  }
}
export type MobileInboxViews = ReturnType<typeof createMobileInboxViews>
