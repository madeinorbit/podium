import { action, compareStructural, observable, observableRef, untracked, when } from 'mobx'
import { headerEntities } from './header-entities'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MachineWire, MessageRecordWire } from '@podium/model'
import { dedupeSessionsByResume } from '@podium/model'
import { companion, lazy } from '@podium/mobx-helpers'
import type { PendingInteractionWire } from '@podium/protocol'
import { CHAT_CONTEXT_SUMMARIES } from './chat-context-schema'
import { headerIds } from './enumerate'
import type { IssueModel, SessionModel } from './models'
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
  const reader = pool.row('chatContextReader', 'reader')
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
  const row = pool.row('issue', id, 'summary-fields') as Loaded<IssueViewModel>
  if (!row || loading(row)) return row
  const repoId = pool.relations.one('issue', id, 'repo')
  const repo = repoId ? (pool.row('repo', repoId) as { prefix?: string } | undefined) : undefined
  return {
    ...row,
    prefix: repo?.prefix,
    displayRef: repo?.prefix ? `${repo.prefix}-${row.seq}` : `#${row.seq}`,
  }
}
export function chatMentionIssues(pool: MobxPool, counts = readerCounts(pool)) {
  if (counts) counts.mentionBuilds++
  const order = pool.row('chatIssueOrder', 'order')
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
    const repo = pool.row('repo', id)
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
  const membership = pool.row('noticeSession', sessionId)
  const rows: PendingInteractionWire[] = []
  let pending = loading(membership) ? 1 : 0
  if (membership && !loading(membership))
    for (const id of membership.interactions) {
      const row = pool.row('pendingInteraction', id)
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
  const membership = pool.row('noticeSession', sessionId)
  const records: MessageRecordWire[] = []
  let pending = loading(membership) ? 1 : 0
  if (membership && !loading(membership))
    for (const id of membership.messages) {
      const row = pool.row('messageRecord', id)
      if (loading(row)) pending++
      else if (row) records.push(row)
    }
  return { records, pending }
}
export function chatArtifactIssue(
  pool: MobxPool,
  session: Pick<SessionView, 'issueId' | 'sessionId'>,
): Loaded<IssueViewModel> {
  if (session.issueId) {
    const direct = pool.row('issue', session.issueId)
    if (loading(direct)) return direct
    if (direct && !(direct as IssueViewModel).deletedAt) return direct as IssueViewModel
  }
  // Normalized membership is the declared raw non-shell attachment relation.
  const owner = pool.relations.one('session', session.sessionId, 'pageIssue')
  const issue = owner ? (pool.row('issue', owner) as Loaded<IssueViewModel>) : undefined
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
    const order = this.pool.row('chatSessionOrder', 'order')
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
    const row = this.pool.row('session', this.model.id, 'summary-fields') as Loaded<SessionView>
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
    const row = pool.row('machine', id)
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
      const catalog = pool.row('superThreadCatalog', 'catalog')
      const threads: import('@podium/client-core/values').SuperThreadView[] = []
      let pending = loading(catalog) ? 1 : 0
      if (catalog && !loading(catalog))
        for (const id of catalog.ids) {
          const row = pool.row('superThread', id)
          if (loading(row)) pending++
          else if (row) threads.push(row)
        }
      return { threads, pending }
    },
  }
}

/** The reference menu's opening order, as identities only: the server's
 * recency order, then any other known row. Resume twins fold by the declared
 * collapse and deleted tasks are outside the mention question, so no row is
 * read; each entry reads its own row when it is shown. */
export function referenceSessionOrder(pool: MobxPool): { ids: string[]; pending: number } {
  const order = pool.row('chatSessionOrder', 'order')
  if (!order || loading(order)) return { ids: [], pending: loading(order) ? 1 : 0 }
  const known = pool.queries.ids({ kind: 'referenceSessions' }),
    present = new Set(known)
  const ids: string[] = []
  for (const id of new Set([...order.ids.filter((id) => present.has(id)), ...known]))
    if (!pool.queries.collapsed(id)) ids.push(id)
  return { ids, pending: 0 }
}
export function mentionIssueOrder(pool: MobxPool): { ids: string[]; pending: number } {
  const order = pool.row('chatIssueOrder', 'order')
  if (!order || loading(order)) return { ids: [], pending: loading(order) ? 1 : 0 }
  const known = pool.queries.ids({ kind: 'mentionIssues' }),
    present = new Set(known)
  return { ids: [...new Set([...order.ids.filter((id) => present.has(id)), ...known])], pending: 0 }
}

/** One open reference/mention picker. Open stores the order (rule 6); search
 * asks the source for a bounded window. Rows are made for shown entries only. */
export class ReferencePicker {
  @observableRef accessor sessionIds: string[] = []
  @observableRef accessor issueIds: string[] = []
  @observable accessor pending = 0
  // A fresh row map per opening: a row keeps the recency it first showed.
  @observableRef private accessor sessionRow = companion((model: SessionModel) => new ReferenceSessionRow(this.pool, model.id))
  @observableRef private accessor issueRow = companion((model: IssueModel) => new ReferenceIssueRow(this.pool, model.id))
  private stopLoading: (() => void) | undefined
  constructor(private readonly pool: MobxPool) {}
  @action close() { this.stopLoading?.(); this.stopLoading = undefined }
  @action open(kind: 'sessions' | 'issues' | 'all' = 'all') {
    this.close()
    const sessions = kind !== 'issues' ? referenceSessionOrder(this.pool) : undefined
    const issues = kind !== 'sessions' ? mentionIssueOrder(this.pool) : undefined
    if (sessions) {
      this.sessionIds = sessions.ids
      this.sessionRow = companion((model: SessionModel) => new ReferenceSessionRow(this.pool, model.id))
    }
    if (issues) {
      this.issueIds = issues.ids
      this.issueRow = companion((model: IssueModel) => new ReferenceIssueRow(this.pool, model.id))
    }
    this.pending = (sessions?.pending ?? 0) + (issues?.pending ?? 0)
    if (this.pending) this.stopLoading = when(() =>
      (kind !== 'issues' ? referenceSessionOrder(this.pool).pending : 0) +
      (kind !== 'sessions' ? mentionIssueOrder(this.pool).pending : 0) === 0,
      () => this.open(kind))
  }
  @action search(query: string, limit = 5) {
    this.close()
    const result = chatMentionMatches(this.pool, query, limit)
    this.issueIds = result.issues.map(issue => issue.id)
    this.issueRow = companion((model: IssueModel) => new ReferenceIssueRow(this.pool, model.id))
    this.pending = result.pending
    if (this.pending) this.stopLoading = when(() => chatMentionMatches(this.pool, query, limit).pending === 0,
      () => this.search(query, limit))
  }
  /** Compatibility lists for consumers of the whole catalog answer: reading
   * one resolves every entry. Picker rows ask by id instead. */
  @lazy({ equals: compareStructural }) get sessions(): SessionView[] {
    return dedupeSessionsByResume(this.sessionIds.flatMap(id => {
      const value = this.sessionRow(this.pool.sessionObject(id)).presentation
      return value && !loading(value) ? [value] : []
    }))
  }
  @lazy({ equals: compareStructural }) get issues(): IssueViewModel[] {
    return this.issueIds.flatMap(id => {
      const value = this.issueRow(this.pool.issueObject(id)).presentation
      return value && !loading(value) ? [value] : []
    })
  }
  session(id: string) { return this.pool.row('session', id, 'summary-fields') as Loaded<SessionView> }
  issue(id: string) { return chatIssue(this.pool, id) }
}
export const createReferencePicker = (pool: MobxPool) => new ReferencePicker(pool)

/** Per-row picker companions answer displayed fields. The recency a row first
 * showed stays put while the picker is open; the live Agents list keeps its
 * timestamp. */
class ReferenceSessionRow {
  private readonly openedAt: string
  constructor(private readonly pool: MobxPool, readonly id: string) {
    // untracked-read: picker-session-recency
    this.openedAt = untracked(() => {
      const row = pool.row('session', id, 'summary-fields') as Loaded<SessionView>
      return row && !loading(row) ? row.lastActiveAt : ''
    })
  }
  @lazy({ equals: compareStructural }) get presentation(): Loaded<SessionView> {
    const row = this.pool.row('session', this.id, 'summary-fields') as Loaded<SessionView>
    if (!row || loading(row)) return row
    return { ...row, lastActiveAt: this.openedAt || row.lastActiveAt }
  }
}
class ReferenceIssueRow {
  private readonly openedAt: string
  constructor(private readonly pool: MobxPool, readonly id: string) {
    // untracked-read: picker-issue-recency
    this.openedAt = untracked(() => {
      const row = chatIssue(pool, id)
      return row && !loading(row) ? row.updatedAt : ''
    })
  }
  @lazy({ equals: compareStructural }) get presentation(): Loaded<IssueViewModel> {
    const row = chatIssue(this.pool, this.id)
    if (!row || loading(row) || row.deletedAt) return undefined
    const { updatedAt, ...fields } = row
    return { ...fields, updatedAt: this.openedAt || updatedAt } as IssueViewModel
  }
}
