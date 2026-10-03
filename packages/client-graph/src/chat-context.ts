import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MessageRecordWire, MachineWire } from '@podium/model'
import { dedupeSessionsByResume } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import type { MobxPool } from './pool'
import { headerIds } from './enumerate'
import type { Loaded } from './worklist/rollup'

// Loaded by the screen attachment only. Web hooks import the reader's type.
export const loading = (row: unknown): row is symbol => typeof row === 'symbol'

// Cumulative diagnostics only: no rows, observable state or subscriptions.
const readCounts = new WeakMap<MobxPool, {
  mentionBuilds: number
  mentionIssueReads: number
  referenceBuilds: number
  referenceSessionReads: number
}>()
export function chatContextReadStats(pool: MobxPool) {
  let counts = readCounts.get(pool)
  if (!counts) {
    counts = { mentionBuilds: 0, mentionIssueReads: 0, referenceBuilds: 0, referenceSessionReads: 0 }
    readCounts.set(pool, counts)
  }
  return counts
}
export function chatIssue(pool: MobxPool, id: string): Loaded<IssueViewModel> {
  const row = pool.row('issue', id, 'summary-fields') as Loaded<IssueViewModel>
  if (!row || loading(row)) return row
  const repoId = pool.relations.one('issue', id, 'repo')
  const repo = repoId ? pool.row('repo', repoId) as { prefix?: string } | undefined : undefined
  return { ...row, prefix: repo?.prefix, displayRef: repo?.prefix ? `${repo.prefix}-${row.seq}` : `#${row.seq}` }
}
export function chatMentionIssues(pool: MobxPool) {
  const counts = chatContextReadStats(pool)
  counts.mentionBuilds++
  const order = pool.row('chatIssueOrder', 'order')
  const issues: IssueViewModel[] = []
  let pending = loading(order) ? 1 : 0
  if (!order || loading(order)) return { issues, pending }
  const known = pool.queries.ids({ kind: 'mentionIssues' }), present = new Set(known)
  for (const id of new Set([...order.ids.filter(id => present.has(id)), ...known])) {
    counts.mentionIssueReads++
    const row = chatIssue(pool, id)
    if (loading(row)) pending++
    else if (row && !row.deletedAt) issues.push(row)
  }
  return { issues, pending }
}
export function chatInteractions(pool: MobxPool, sessionId: string) {
  const order = pool.row('superagentQuestionOrder', 'order')
  const membership = pool.row('noticeSession', sessionId)
  const rows: PendingInteractionWire[] = []
  let pending = (loading(order) ? 1 : 0) + (loading(membership) ? 1 : 0)
  const mine = membership && !loading(membership) ? new Set(membership.interactions) : new Set<string>()
  if (order && !loading(order)) for (const id of order.ids) {
    if (!mine.has(id)) continue
    const row = pool.row('pendingInteraction', id)
    if (loading(row)) pending++
    else if (row?.sessionId === sessionId && row.status === 'asked') rows.push(row)
  }
  return { blocked: rows.length > 0, question: rows.find(row => row.kind === 'question'), pending }
}
export function chatRecords(pool: MobxPool, sessionId: string) {
  const membership = pool.row('noticeSession', sessionId)
  const order = pool.row('chatRecordOrder', 'order')
  const records: MessageRecordWire[] = []
  let pending = (loading(membership) ? 1 : 0) + (loading(order) ? 1 : 0)
  const mine = membership && !loading(membership) ? new Set(membership.messages) : new Set<string>()
  if (order && !loading(order)) for (const id of order.ids) {
    if (!mine.has(id)) continue
    const row = pool.row('messageRecord', id)
    if (loading(row)) pending++
    else if (row) records.push(row)
  }
  return { records, pending }
}
export function chatArtifactIssue(pool: MobxPool, session: Pick<SessionView, 'issueId' | 'sessionId'>): Loaded<IssueViewModel> {
  if (session.issueId) {
    const direct = pool.row('issue', session.issueId)
    if (loading(direct)) return direct
    if (direct && !(direct as IssueViewModel).deletedAt) return direct as IssueViewModel
  }
  // Normalized membership is the declared raw non-shell attachment relation.
  const owner = pool.relations.one('session', session.sessionId, 'pageIssue')
  const issue = owner ? pool.row('issue', owner) as Loaded<IssueViewModel> : undefined
  return issue && !loading(issue) && issue.deletedAt ? undefined : issue
}
export function chatReferenceSessions(pool: MobxPool) {
  const counts = chatContextReadStats(pool)
  counts.referenceBuilds++
  const order = pool.row('chatSessionOrder', 'order')
  const sessions: SessionView[] = []
  let pending = loading(order) ? 1 : 0
  if (!order || loading(order)) return { sessions, pending }
  const known = pool.queries.ids({ kind: 'referenceSessions' }), present = new Set(known)
  for (const id of new Set([...order.ids.filter(id => present.has(id)), ...known])) {
    counts.referenceSessionReads++
    const row = pool.row('session', id, 'summary-fields') as Loaded<SessionView>
    if (loading(row)) pending++
    else if (row) sessions.push(row)
  }
  return { sessions: dedupeSessionsByResume(sessions), pending }
}
export function chatReferenceMachines(pool: MobxPool): MachineWire[] {
  return headerIds(pool, 'machine').flatMap(id => {
    const row = pool.row('machine', id)
    return row && !loading(row) ? [row as MachineWire] : []
  })
}
export function chatRepositoryKey(pool: MobxPool): string {
  return headerIds(pool, 'repository').flatMap(id => {
    const row = pool.row('repository', id) as { path: string } | undefined
    return row ? [row.path] : []
  }).sort().join('\n')
}

export function createChatContextReader(pool: MobxPool) {
  return {
    issue: (id: string) => chatIssue(pool, id),
    mentions: () => chatMentionIssues(pool),
    interactions: (id: string) => chatInteractions(pool, id),
    records: (id: string) => chatRecords(pool, id),
    artifactIssue: (session: Pick<SessionView, 'sessionId' | 'issueId'>) => chatArtifactIssue(pool, session),
    sessions: () => chatReferenceSessions(pool),
    machines: () => chatReferenceMachines(pool),
    repositoryKey: () => chatRepositoryKey(pool),
    threads() {
      const catalog = pool.row('superThreadCatalog', 'catalog')
      const threads: import('@podium/client-core/viewmodels').SuperThreadView[] = []
      let pending = loading(catalog) ? 1 : 0
      if (catalog && !loading(catalog)) for (const id of catalog.ids) {
        const row = pool.row('superThread', id)
        if (loading(row)) pending++
        else if (row) threads.push(row)
      }
      return { threads, pending }
    },
  }
}
