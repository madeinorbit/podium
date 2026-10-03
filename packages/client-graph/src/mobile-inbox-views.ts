import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { PodiumTarget } from '@podium/protocol'
import { parseSessionRef } from '@podium/protocol'
import { compareStructural, computed, reaction } from 'mobx'
import { knownIssueIds, knownSessionIds } from './enumerate'
import { issuePages } from './issue-page'
import type { MobxPool } from './pool'
import { LOADING, type Loaded } from './worklist/rollup'

/** Constructed only with the enabled attachment. Shared computed readers keep
 * callbacks and retained chips addressed to this pool and this principal. */
export function createMobileInboxViews(pool: MobxPool) {
  const waits = new Set<() => void>()
  const booting = () => {
    const state = pool.row('mobileInboxState', 'state')
    return !state || state === LOADING || (!state.hasCursor && knownSessionIds(pool).length === 0 && knownIssueIds(pool).length === 0)
  }
  const inbox = computed(() => {
    const sessions: SessionView[] = [], issues: Record<string, IssueViewModel> = {}
    let loading = booting()
    for (const id of knownSessionIds(pool)) {
      if (pool.graph.isCollapsed('session', id)) continue
      const summary = pool.row('session', id, 'summary') as Loaded<SessionView>
      if (summary === LOADING) { loading = true; continue }
      if (!summary || summary.archived || summary.headless || summary.agentKind === 'shell') continue
      const session = pool.row('session', id) as Loaded<SessionView>
      if (session === LOADING) { loading = true; continue }
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
    return { groups: groupSessions(withoutShells(sessions)), issues, booting: loading, outboxSize: window?.outboxSize ?? 0 }
  }, { equals: compareStructural })
  const screening = computed(() => {
    type Summary = Pick<IssueViewModel, 'id' | 'stage' | 'parentId' | 'archived' | 'deletedAt' | 'isDraftVessel' | 'audience' | 'priority' | 'seq'>
    const summaries = new Map<string, Summary>()
    let loading = booting()
    for (const id of knownIssueIds(pool)) {
      const row = pool.row('issue', id, 'summary') as Loaded<Summary>
      if (row === LOADING) loading = true
      else if (row) summaries.set(id, row)
    }
    const underProposal = (issue: Summary) => {
      const seen = new Set<string>([issue.id])
      let id = issue.parentId
      while (id && !seen.has(id)) {
        seen.add(id)
        const parent = summaries.get(id)
        if (!parent) return false
        if (parent.stage === 'proposed') return true
        id = parent.parentId
      }
      return false
    }
    const queue = [...summaries.values()].filter(issue => issue.stage === 'proposed' && !issue.archived && !issue.deletedAt &&
      !issue.isDraftVessel && issue.audience !== 'agent' && !underProposal(issue))
      .sort((a, b) => a.priority - b.priority || b.seq - a.seq).map(issue => issue.id)
    return { queue, booting: loading }
  }, { equals: compareStructural })
  function screeningRows(ids: readonly string[]) {
    const issues: Record<string, IssueViewModel> = {}
    let loading = false
    for (const id of ids) {
      if (!id || issues[id]) continue
      const issue = issuePages(pool).issue(id)
      if (issue === LOADING) { loading = true; continue }
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
    const prefixes = pool.row('mobileReferencePrefixes', 'prefixes')
    const known = !!prefixes && prefixes !== LOADING && prefixes.prefixes.includes(prefix)
    const model = known && refKind === 'issue' ? pool.references.read(token) : null
    return { known, model: model === LOADING ? null : model ?? null }
  }
  function session(identifier: string): Loaded<SessionView> {
    const trimmed = identifier.trim()
    const direct = pool.row('session', trimmed, 'summary') as Loaded<SessionView>
    if (direct && direct !== LOADING && !pool.graph.isCollapsed('session', trimmed)) return direct
    if (!parseSessionRef(trimmed)) return direct === LOADING ? LOADING : undefined
    let pending = false
    // The permanent ref is a declared small summary; no cold session index.
    // Match the runtime's order and resume collapse when duplicate refs exist.
    const ids = knownSessionIds(pool).sort((a, b) => pool.graph.orderKey('session', a).localeCompare(pool.graph.orderKey('session', b)))
    for (const id of ids) {
      if (pool.graph.isCollapsed('session', id)) continue
      const row = pool.row('session', id, 'summary') as Loaded<SessionView>
      if (row === LOADING) pending = true
      else if (row?.displayRef === trimmed) return row
    }
    return pending ? LOADING : undefined
  }
  function route(target: PodiumTarget): Loaded<string | null> {
    if (target.kind !== 'issue' && target.kind !== 'session' || target.search || target.hash) return null
    if (target.kind === 'session') {
      const row = session(target.session)
      return row === LOADING ? LOADING : row ? `/session/${encodeURIComponent(row.sessionId)}` : null
    }
    const direct = pool.row('issue', target.issue.trim(), 'summary') as Loaded<{ id: string }>
    if (direct && direct !== LOADING) return `/issue/${encodeURIComponent(direct.id)}`
    const id = pool.references.id(target.issue)
    return id === LOADING ? LOADING : id ? `/issue/${encodeURIComponent(id)}` : null
  }
  function resolveRoute(target: PodiumTarget): string | null | Promise<string | null> {
    const current = route(target)
    if (current !== LOADING) return current ?? null
    return new Promise(resolve => {
      let stop: (() => void) | undefined, finished = false
      const finish = (value: string | null) => { finished = true; stop?.(); waits.delete(cancel); resolve(value) }
      const cancel = () => finish(null)
      waits.add(cancel)
      stop = reaction(() => route(target), value => { if (value !== LOADING) finish(value ?? null) }, { fireImmediately: true })
      if (finished) stop()
    })
  }
  return { inbox: () => inbox.get(), screening: () => screening.get(), screeningRows, chip, route, resolveRoute, booting,
    session, dispose() { for (const cancel of [...waits]) cancel() } }
}
export type MobileInboxViews = ReturnType<typeof createMobileInboxViews>
