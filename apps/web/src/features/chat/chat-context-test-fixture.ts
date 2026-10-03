import type { ClientRuntime, Store } from '@podium/client-core/engine'
import { outboxChatSends } from '@podium/client-core/engine/chat-send'
import type { IssueViewModel, ReplicaAddressedBatch } from '@podium/client-core/replica'
import { asIssueId, asMutationId, asSessionId } from '@podium/model/browser'
import { dedupeSessionsByResume } from '@podium/model'
import { MobxPool } from '@podium/client-graph'
import { CHAT_CONTEXT_ENTITIES, CHAT_CONTEXT_SUMMARIES } from '@podium/client-graph/chat-context-schema'
import { ChatContextSource } from '@podium/client-graph/chat-context-source'
import { NoticeSource } from '@podium/client-graph/notice-source'
import { NOTICE_ENTITIES } from '@podium/client-graph/notice-schema'
import { createSuperagentSource, SUPERAGENT_ENTITIES } from '@podium/client-graph/superagent'
import { noticeFixture } from '@podium/client-graph/diagnostics/notice-fixture'
import { checkChatContext } from './chat-context-check'

/** Synthetic corpus shared by the focused reader/UI checks. No external app,
 * database, socket or additional mutation owner is constructed. */
export async function createChatContextFixture(resumeTwins = false) {
  const data = noticeFixture()
  const rawSessions = data.sessions.map((row, index) => ({ ...row, privateBody: 'Undeclared cold payload', issueId: asIssueId(index ? 'cold-issue' : 'chat-issue'),
    displayRef: index ? 'SYN-2-A' : 'SYN-1-A', machineId: 'chat-machine', status: index ? 'exited' : 'live',
    archived: index > 0, lastActiveAt: index ? '2020-01-01T00:00:00Z' : '2026-10-01T12:00:00Z' })) as Store['sessions']
  if (resumeTwins) {
    const cold = rawSessions[1]!
    cold.resume = { kind: 'codex', value: 'synthetic-native-id' }
    rawSessions.push({ ...cold, sessionId: asSessionId('parked-twin'), displayRef: 'SYN-2-B', lastActiveAt: '2021-01-01T00:00:00Z' })
    rawSessions.push({ ...rawSessions[0]!, sessionId: asSessionId('active-twin'), displayRef: 'SYN-1-B', resume: { kind: 'codex', value: 'synthetic-active-id' } })
    rawSessions[0]!.resume = { kind: 'codex', value: 'synthetic-active-id' }
    rawSessions.push({ ...cold, sessionId: asSessionId('headless-twin'), displayRef: 'SYN-2-C', headless: true })
  }
  const sessions = dedupeSessionsByResume(rawSessions)
  const issues = Array.from({ length: 9 }, (_, index) => ({ id: asIssueId(index === 0 ? 'chat-issue' : index === 1 ? 'cold-issue' : `chat-issue-${index}`),
    seq: index + 1, repoId: 'chat-repo', repoPath: '/synthetic/project', prefix: 'SYN', displayRef: `SYN-${index + 1}`,
    title: index === 3 ? 'Other composer task' : 'Synthetic task', stage: index === 1 ? 'done' : 'in_progress', archived: index === 1,
    deletedAt: index === 8 ? '2026-10-01T12:00:00Z' : null, updatedAt: '2026-10-01T12:00:00Z', createdAt: '2020-01-01T00:00:00Z',
    worktreePath: index ? null : '/synthetic/project', deps: [], coordinatorSessionId: index ? undefined : sessions[0]!.sessionId,
    memberSessionIds: sessions.filter(row => row.issueId === (index ? index === 1 ? 'cold-issue' : `chat-issue-${index}` : 'chat-issue')).map(row => row.sessionId),
    panel: index === 0 ? { artifacts: [{ path: 'concept.html', title: 'Synthetic concept', artifactId: 'opaque-artifact', entry: 'concept.html', addedAt: '2026-10-01T12:00:00Z' }] } : undefined,
  })) as unknown as IssueViewModel[]
  let messages = data.messages, interactions = [...data.interactions].reverse()
  let queued = [{ mutationId: asMutationId('held-live'), kind: 'sendText', input: { sessionId: sessions[0]!.sessionId, text: 'Held synthetic send' }, queuedAt: 2 }]
  let parked = [{ entry: { mutationId: asMutationId('held-failed'), kind: 'resumeAndSend', input: { sessionId: sessions[0]!.sessionId, text: 'Saved synthetic send' }, queuedAt: 1 }, reason: { code: 'max-age' }, parkedFrom: 'expired', deadLetteredAt: 3, attempts: 2 }]
  const listeners = new Set<() => void>(), outboxListeners = new Set<() => void>(), addressed = new Set<(batch: ReplicaAddressedBatch) => void>()
  const counts = { collections: 0, addresses: 0 }
  const raw = (kind: string): readonly object[] => kind === 'sessions' ? rawSessions : kind === 'issueProjections' ? issues
    : kind === 'messageRecords' ? messages : kind === 'pendingInteractions' ? interactions : []
  let state: Store
  const owner = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    readPosition: { get: () => ({ lastEventId: 0, seenAt: null }), subscribe: () => () => {} },
    replica: { rows: (kind: string) => { counts.collections++; return raw(kind) }, getCursor: () => 1,
      row: (kind: string, id: string) => { counts.addresses++; return raw(kind).find(row => Reflect.get(row, kind === 'sessions' ? 'sessionId' : 'id') === id) },
      subscribeAddressedBatch: (fn: (batch: ReplicaAddressedBatch) => void) => { addressed.add(fn); return () => { addressed.delete(fn) } } },
    outbox: { pending: () => queued, deadLetters: () => parked, subscribe: (fn: () => void) => { outboxListeners.add(fn); return () => { outboxListeners.delete(fn) } } },
  } as unknown as ClientRuntime
  state = { sessions, messageRecords: messages, pendingInteractions: interactions, issueProjections: issues,
    drafts: { [sessions[0]!.sessionId]: 'Saved draft' }, attachedSessionId: sessions[1]!.sessionId, transcriptReveal: null,
    superThreads: [{ id: 'own-thread', kind: 'global', title: 'Synthetic thread', podiumSessionId: sessions[0]!.sessionId }],
    superThreadId: 'own-thread', paneA: null, selectedWorktree: null, machines: [{ id: 'chat-machine', name: 'Synthetic host', online: true }],
    repos: [{ path: '/synthetic/project' }], chatSendsFor: id => outboxChatSends(owner.outbox, id), replica: owner.replica,
    setSessionDraft: (id: string, text: string) => {
      state = { ...state, drafts: { ...state.drafts, [id]: text } }
      for (const fn of listeners) fn()
    },
  } as unknown as Store
  const pool = new MobxPool({ coarseNow: Date.parse('2026-10-01T13:00:00Z'), selectedIssueId: null }, undefined,
    { summaries: CHAT_CONTEXT_SUMMARIES, load: (entity, id) => (entity === 'issue' ? issues : rawSessions).find(row => ('id' in row ? row.id : row.sessionId) === id) as never, schedule: () => () => {} })
  pool.apply({ type: 'replace', rows: [
    { kind: 'repo', id: 'chat-repo', value: { id: 'chat-repo', path: '/synthetic/project', prefix: 'SYN' } as never },
    ...issues.map(row => ({ kind: 'issue' as const, id: row.id, value: row as never })),
    ...rawSessions.map(row => ({ kind: 'session' as const, id: row.sessionId, value: row as never })),
  ] })
  pool.header.apply([{ kind: 'machine', id: 'chat-machine', value: state.machines[0]! },
    { kind: 'repository', id: '/synthetic/project', value: state.repos[0]! }])
  pool.header.order('machine', ['chat-machine']); pool.header.order('repository', ['/synthetic/project'])
  pool.sources.register(NOTICE_ENTITIES, new NoticeSource(owner))
  pool.sources.register(SUPERAGENT_ENTITIES, await createSuperagentSource(owner))
  const source = new ChatContextSource(owner, pool)
  pool.sources.register(CHAT_CONTEXT_ENTITIES, source)
  const check = (override = state, models = issues.filter(row => !row.deletedAt)) => checkChatContext(pool, override, models, sessions.map(row => row.sessionId))
  const load = async () => {
    for (let round = 0; round < 6; round++) { check(); await Promise.resolve(); pool.hydrate() }
    return check()
  }
  return { pool, owner, source, counts, issues, sessions, data, check, load, state: () => state, addressed, listeners, outboxListeners,
    updateDraft(text: string) { state.setSessionDraft(sessions[0]!.sessionId, text) },
    updateMessages(next: typeof messages, ids: string[]) {
      messages = next; state = { ...state, messageRecords: next }
      for (const fn of addressed) fn({ type: 'update', rows: ids.map(id => ({ kind: 'messageRecords', id })) })
    },
    updateInteractions(next: typeof interactions, ids: string[]) {
      interactions = next; state = { ...state, pendingInteractions: next }
      for (const fn of addressed) fn({ type: 'update', rows: ids.map(id => ({ kind: 'pendingInteractions', id })) })
    },
    discardHeld() { queued = []; parked = []; for (const fn of outboxListeners) fn() },
    replaceEmpty() { messages = []; interactions = []; state = { ...state, messageRecords: [], pendingInteractions: [] }; for (const fn of addressed) fn({ type: 'replace', reason: 'rescope' }) },
  }
}
