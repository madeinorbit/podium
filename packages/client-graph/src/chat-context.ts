import type { MessageModel } from './message-models'
import { omitGone } from './lookup'
import { action, compareStructural, observable, observableRef, when } from 'mobx'
import { headerEntities } from './header-entities'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MachineWire } from '@podium/model'
import { dedupeSessionsByResume } from '@podium/model'
import { companion, lazy } from '@podium/mobx-helpers'
import type { PendingInteractionWire } from '@podium/protocol'
import { CHAT_CONTEXT_SUMMARIES } from './chat-context-schema'
import { headerIds } from './enumerate'
import type { SessionModel } from './models'
import type { MobxPool } from './pool'
import type { Loaded } from './worklist/rollup'

// Loaded by the screen attachment only. Web hooks import the reader's type.
export const loading = (row: unknown): row is symbol => typeof row === 'symbol'

// Cumulative diagnostics live on the pool's existing chat reader. They retain
// no rows and create no observable state or subscriptions.
type ChatReadCounts = {
  mentionBuilds: number
  mentionIssueReads: number
  referenceBuilds: number
  referenceSessionReads: number
}
function readerCounts(pool: MobxPool): ChatReadCounts | undefined {
  const reader = omitGone(pool.row('chatContextReader', 'reader'))
  return reader && !loading(reader) ? reader.counts : undefined
}
export function chatContextReadStats(pool: MobxPool): Readonly<ChatReadCounts> {
  return (
    readerCounts(pool) ?? {
      mentionBuilds: 0,
      mentionIssueReads: 0,
      referenceBuilds: 0,
      referenceSessionReads: 0,
    }
  )
}
export function chatIssue(pool: MobxPool, id: string): Loaded<IssueViewModel> {
  const row = omitGone(pool.row('issue', id, 'summary-fields')) as Loaded<IssueViewModel>
  if (!row || loading(row)) return row
  const repoId = pool.relations.one('issue', id, 'repo')
  const repo = repoId ? (omitGone(pool.row('repo', repoId)) as { prefix?: string } | undefined) : undefined
  return {
    ...row,
    prefix: repo?.prefix,
    displayRef: repo?.prefix ? `${repo.prefix}-${row.seq}` : `#${row.seq}`,
  }
}
export function chatMentionIssues(pool: MobxPool, counts = readerCounts(pool)) {
  if (counts) counts.mentionBuilds++
  const order = omitGone(pool.row('chatIssueOrder', 'order'))
  const issues: IssueViewModel[] = []
  let pending = loading(order) ? 1 : 0
  if (!order || loading(order)) return { issues, pending }
  const known = pool.queries.ids({ kind: 'mentionIssues' }),
    present = new Set(known)
  for (const id of new Set([...order.ids.filter((id) => present.has(id)), ...known])) {
    if (counts) counts.mentionIssueReads++
    const row = chatIssue(pool, id)
    if (loading(row)) pending++
    else if (row && !row.deletedAt) issues.push(row)
  }
  return { issues, pending }
}
/** Source-ranked identities cap summary demand before it reaches the chat. */
export function chatMentionMatches(
  pool: MobxPool,
  query: string,
  limit = 5,
  counts = readerCounts(pool),
) {
  if (counts) counts.mentionBuilds++
  const prefixes: Record<string, string | undefined> = {}
  for (const id of pool.tables.repo.keys()) {
    const repo = omitGone(pool.row('repo', id))
    if (repo && !loading(repo)) prefixes[id] = (repo as { prefix?: string }).prefix
  }
  const ids = pool.queries.ids({ kind: 'issueMentionMatches', query, limit, prefixes })
  const issues: IssueViewModel[] = []
  let pending = 0
  for (const id of ids) {
    if (counts) counts.mentionIssueReads++
    const issue = chatIssue(pool, id)
    if (loading(issue)) pending++
    else if (issue && !issue.deletedAt && !issue.archived) issues.push(issue)
  }
  return { issues, pending }
}
export function chatInteractions(pool: MobxPool, sessionId: string) {
  const membership = omitGone(pool.row('noticeSession', sessionId))
  const rows: PendingInteractionWire[] = []
  let pending = loading(membership) ? 1 : 0
  if (membership && !loading(membership))
    for (const id of membership.interactions) {
      const row = omitGone(pool.model('pendingInteraction', id))
      if (loading(row)) pending++
      else if (row?.sessionId === sessionId && row.status === 'asked') rows.push(row)
    }
  return {
    blocked: rows.length > 0,
    question: rows.find((row) => row.kind === 'question'),
    pending,
  }
}
export function chatRecords(pool: MobxPool, sessionId: string) {
  const membership = omitGone(pool.row('noticeSession', sessionId))
  const records: MessageModel[] = []
  let pending = loading(membership) ? 1 : 0
  if (membership && !loading(membership))
    for (const id of membership.messages) {
      const row = omitGone(pool.model('message', id))
      if (loading(row)) pending++
      else if (row) { row.row; records.push(row) }
    }
  return { records, pending }
}
export function chatArtifactIssue(
  pool: MobxPool,
  session: Pick<SessionView, 'issueId' | 'sessionId'>,
): Loaded<IssueViewModel> {
  if (session.issueId) {
    const direct = omitGone(pool.row('issue', session.issueId))
    if (loading(direct)) return direct
    if (direct && !(direct as IssueViewModel).deletedAt) return direct as IssueViewModel
  }
  // Normalized membership is the declared raw non-shell attachment relation.
  const owner = pool.relations.one('session', session.sessionId, 'pageIssue')
  const issue = owner ? (omitGone(pool.row('issue', owner)) as Loaded<IssueViewModel>) : undefined
  return issue && !loading(issue) && issue.deletedAt ? undefined : issue
}
export function chatReferenceSessions(pool: MobxPool, counts = readerCounts(pool)) {
  return pool.sources
    .view('chat-reference-sessions', () =>
      createReferenceSessionProjection(pool, CHAT_CONTEXT_SUMMARIES.session, counts),
    )
    .sessions()
}

/** The shared list and per-session companions are observed only while needed.
 * A payload replacement compares its declared reference fields before the list
 * can be invalidated. Imperative reads and reopening always see current data. */
export function createReferenceSessionProjection(
  pool: MobxPool,
  fields?: readonly (keyof SessionView)[],
  counts = readerCounts(pool),
) {
  return new ReferenceSessionProjection(pool, fields, counts)
}

class ReferenceSessionProjection {
  private readonly session = companion((model: SessionModel) =>
    new ReferenceSessionSummary(this.pool, model, this.fields, this.counts),
  )
  constructor(
    private readonly pool: MobxPool,
    private readonly fields: readonly (keyof SessionView)[] | undefined,
    private readonly counts: ChatReadCounts | undefined,
  ) {}
  sessions() { return this.result }
  @lazy private get result() {
    if (this.counts) this.counts.referenceBuilds++
    const order = omitGone(this.pool.row('chatSessionOrder', 'order'))
    const sessions: SessionView[] = []
    let pending = loading(order) ? 1 : 0
    if (!order || loading(order)) return { sessions, pending }
    const known = this.pool.queries.ids({ kind: 'referenceSessions' }),
      present = new Set(known)
    for (const id of new Set([...order.ids.filter((id) => present.has(id)), ...known])) {
      const row = this.session(this.pool.sessionObject(id)).presentation
      if (loading(row)) pending++
      else if (row) sessions.push(row)
    }
    return { sessions: dedupeSessionsByResume(sessions), pending }
  }
}

/** Compatibility presentation for the existing SessionView reader contract.
 * The companion borrows the pool's shared model; only its small declared field
 * projection is compared, never the complete reference list. */
class ReferenceSessionSummary {
  constructor(
    private readonly pool: MobxPool,
    private readonly model: SessionModel,
    private readonly fields: readonly (keyof SessionView)[] | undefined,
    private readonly counts: ChatReadCounts | undefined,
  ) {}
  @lazy({ equals: compareStructural }) get presentation(): Loaded<SessionView> {
    if (this.counts) this.counts.referenceSessionReads++
    const row = omitGone(this.pool.row('session', this.model.id, 'summary-fields')) as Loaded<SessionView>
    if (!row || loading(row)) return row
    // Reference cards name their fields; the phone roster preserves the
    // richer declared summary and resident metadata it already consumed.
    const projected = this.fields
      ? Object.fromEntries(this.fields.map(key => [key, this.model.storedField(key)])) as unknown as SessionView
      : { ...row }
    if (projected.resume)
      projected.resume = { kind: projected.resume.kind, value: projected.resume.value }
    return projected
  }
}
export function chatReferenceMachines(pool: MobxPool): MachineWire[] {
  return headerIds(pool, 'machine').flatMap((id) => {
    const row = omitGone(pool.row('machine', id))
    return row && !loading(row) ? [row as MachineWire] : []
  })
}
export function chatRepositoryKey(pool: MobxPool): string {
  // This opaque key only drives a path-change effect. The header owner
  // maintains the revision from changed path contributions at ingestion.
  const revision = headerEntities(pool).repositoryPathsRevision()
  return revision === 0 ? '' : String(revision)
}

export function createChatContextReader(pool: MobxPool) {
  const counts: ChatReadCounts = {
    mentionBuilds: 0,
    mentionIssueReads: 0,
    referenceBuilds: 0,
    referenceSessionReads: 0,
  }
  return {
    counts,
    issue: (id: string) => chatIssue(pool, id),
    mentions: (query?: string, limit = 5) =>
      query === undefined
        ? chatMentionIssues(pool, counts)
        : chatMentionMatches(pool, query, limit, counts),
    interactions: (id: string) => chatInteractions(pool, id),
    records: (id: string) => chatRecords(pool, id),
    artifactIssue: (session: Pick<SessionView, 'sessionId' | 'issueId'>) =>
      chatArtifactIssue(pool, session),
    referencePicker: () => createReferencePicker(pool),
    sessions: () => chatReferenceSessions(pool, counts),
    machines: () => chatReferenceMachines(pool),
    repositoryKey: () => chatRepositoryKey(pool),
    threads() {
      const catalog = omitGone(pool.row('superThreadCatalog', 'catalog'))
      const threads: import('@podium/client-core/values').SuperThreadView[] = []
      let pending = loading(catalog) ? 1 : 0
      if (catalog && !loading(catalog))
        for (const id of catalog.ids) {
          const row = omitGone(pool.row('superThread', id))
          if (loading(row)) pending++
          else if (row) threads.push(row)
        }
      return { threads, pending }
    },
  }
}

/** The open mention menu. A search asks the source for a bounded window of
 * identities; each shown entry reads its own row by id. */
export class ReferencePicker {
  @observableRef accessor issueIds: string[] = []
  @observable accessor pending = 0
  private stopLoading: (() => void) | undefined
  constructor(private readonly pool: MobxPool) {}
  @action close() { this.stopLoading?.(); this.stopLoading = undefined }
  @action search(query: string, limit = 5) {
    this.close()
    const result = chatMentionMatches(this.pool, query, limit)
    this.issueIds = result.issues.map(issue => issue.id)
    this.pending = result.pending
    if (this.pending) this.stopLoading = when(() => chatMentionMatches(this.pool, query, limit).pending === 0,
      () => this.search(query, limit))
  }
  issue(id: string) { return chatIssue(this.pool, id) }
}
export const createReferencePicker = (pool: MobxPool) => new ReferencePicker(pool)
