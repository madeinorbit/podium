/** Opt-in comparison following sidebar-check. The report exports only counts
 * and positions; both sets of words and authored sends remain in memory. */
import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { issueViewModelsFromReplica, type IssueViewModel } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import { compareSidebarSnapshots, type CheckSection } from '@podium/client-graph/diagnostics/sidebar-check'
import { chatMentionIssues, chatInteractions, chatRecords, chatArtifactIssue, chatReferenceSessions, chatReferenceMachines, chatRepositoryKey, chatIssue } from '@podium/client-graph/chat-context'
import { issueMentions } from '@/lib/at-mention/mention-sources'
import { sessionForIssue, resolveRef } from '@/lib/ref-miniview'

const loading = (row: unknown): row is symbol => typeof row === 'symbol'
export function checkChatContext(pool: MobxPool, state: Store, issues: readonly IssueViewModel[], ids: readonly string[], queries = ['', 'SYN', 'task', '1']) {
  const expected: CheckSection[] = [], actual: CheckSection[] = []
  let pending = 0
  const compare = (key: string, before: unknown, after: unknown, waiting = false) => {
    const fields = { value: before }, next = { value: after }
    expected.push({ key, fields, rows: [] })
    actual.push({ key, fields: next, pendingFields: waiting ? ['value'] : [], rows: [] })
    if (waiting) pending++
  }
  const mentions = chatMentionIssues(pool)
  for (const query of queries) compare(`mentions:${queries.indexOf(query)}`, issueMentions(issues, query, 5), issueMentions(mentions.issues, query, 5), mentions.pending > 0)
  const window = pool.row('chatWindow', 'window')
  compare('window', { attachedSessionId: state.attachedSessionId ?? null, transcriptReveal: state.transcriptReveal ?? null }, window, loading(window))
  for (const id of ids) {
    const asks = chatInteractions(pool, id), records = chatRecords(pool, id)
    const draft = pool.row('chatDraft', id), held = pool.row('chatHeld', id)
    const session = state.sessions.find(row => row.sessionId === id)
    compare(`draft:${id}`, state.drafts?.[id] ?? '', draft && !loading(draft) ? draft.text : '', loading(draft))
    const mine = (state.pendingInteractions ?? []).filter(row => row.sessionId === id && row.status === 'asked')
    compare(`pending:${id}`, { blocked: mine.length > 0, question: mine.find(row => row.kind === 'question') },
      { blocked: asks.blocked, question: asks.question }, asks.pending > 0)
    compare(`records:${id}`, (state.messageRecords ?? []).filter(row => row.sessionId === id), records.records, records.pending > 0)
    const serialSends = (sends: ReturnType<Store['chatSendsFor']> | readonly import('@podium/client-core/engine/chat-send').OutboxChatSend[]) => sends.map(send => ({ ...send, failure: send.failure ? { message: send.failure.message, retryable: send.failure.retryable } : undefined }))
    compare(`outbox:${id}`, serialSends(state.chatSendsFor(id as never)), held && !loading(held) ? serialSends(held.sends) : [], loading(held))
    if (session) {
      const artifact = chatArtifactIssue(pool, session)
      const old = issues.find(row => row.id === session.issueId) ?? issues.find(row => row.memberSessionIds?.includes(session.sessionId))
      const facts = (issue: IssueViewModel | undefined) => issue ? { id: issue.id, panel: issue.panel, root: issue.worktreePath ?? issue.repoPath, machineId: issue.machineId } : undefined
      compare(`artifacts:${id}`, facts(old), facts(artifact && !loading(artifact) ? artifact : undefined), loading(artifact))
    }
  }
  const sessions = chatReferenceSessions(pool)
  const sessionFacts = (rows: Store['sessions']) => rows.map(({ sessionId, displayRef, cwd, issueId, title, name, archived, status, lastActiveAt, agentKind }) => ({ sessionId, displayRef, cwd, issueId, title, name, archived, status, lastActiveAt, agentKind }))
  compare('referenceSessions', sessionFacts(state.sessions), sessionFacts(sessions.sessions), sessions.pending > 0)
  compare('referenceMachines', state.machines, chatReferenceMachines(pool))
  compare('referenceRepos', state.repos.map(row => row.path).sort().join('\n'), chatRepositoryKey(pool))
  const reader = pool.row('chatContextReader', 'reader')
  const threads = reader && !loading(reader) ? reader.threads() : { threads: [], pending: 1 }
  compare('threads', state.superThreads ?? [], threads.threads, threads.pending > 0)
  const targetIdentity = (target: ReturnType<typeof sessionForIssue>) => target ? { sessionId: target.session.sessionId, via: target.via.id } : null
  for (const issue of issues.slice(0, 8)) {
    compare(`sessionTarget:${issue.id}`, targetIdentity(sessionForIssue(issue, issues, state.sessions)), targetIdentity(sessionForIssue(issue, issues, sessions.sessions)), sessions.pending > 0)
    const row = chatIssue(pool, issue.id)
    compare(`issueSeq:${issue.id}`, issue.seq, row && !loading(row) ? row.seq : null, loading(row))
  }
  const refIdentity = (target: ReturnType<typeof resolveRef>) => target?.kind === 'session' ? { kind: target.kind, ref: target.ref, sessionId: target.session.sessionId } : target
  for (const session of state.sessions.filter(row => row.displayRef).slice(0, 8)) compare(`reference:${session.sessionId}`,
    refIdentity(resolveRef(session.displayRef!, [], state.sessions)), refIdentity(resolveRef(session.displayRef!, [], sessions.sessions)), sessions.pending > 0)
  const result = compareSidebarSnapshots({ sections: expected, pending: 0 }, { sections: actual, pending })
  return { differences: result.differences, pending: result.pending, positions: expected.length,
    first: result.first ? { sectionIndex: result.first.sectionIndex, rowIndex: result.first.rowIndex, field: result.first.field } : null }
}
export function installChatContextCheck(pool: MobxPool, runtime: ClientRuntime): () => void {
  if (typeof window === 'undefined') return () => {}
  const check = () => {
    const state = runtime.getSnapshot()
    return checkChatContext(pool, state, [...issueViewModelsFromReplica(runtime.replica, state.issueProjections, state.issueUserStates).values()], state.sessions.slice(0, 12).map(row => row.sessionId))
  }
  Object.assign(window, { __chatContextCheck: check })
  return () => { if (Reflect.get(window, '__chatContextCheck') === check) Reflect.deleteProperty(window, '__chatContextCheck') }
}
