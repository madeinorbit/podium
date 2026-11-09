import { disposeFixtureUi } from '@podium/client-core/test-support/ui'
import '@podium/client-graph/synced-models'
import {
  noticeSourcePorts,
  superagentSourcePorts,
  replicaSourcePorts,
  chatSourcePorts,
} from '@podium/client-graph/source-ports'
import { headerEntities } from '@podium/client-graph/header-entities'
import { DraftStore } from '@podium/client-core/conversation'
import type { ClientRuntime } from '@podium/client-core/engine'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { headerEntities } from '@podium/client-graph/header-entities'
import { seedFixtureMachines } from '@podium/client-graph/live-fixture'
import type { ReferenceState } from '../../../../tests/worklist/diagnostics/reference-state'

type Store = ReferenceState & { drafts: Record<string, string> }

import { outboxChatSends } from '@podium/client-core/engine'
import type { IssueViewModel, ReplicaAddressedBatch } from '@podium/client-core/replica'
import {
  asIssueId,
  asMachineId,
  asRepoId,
  asMutationId,
  asSessionId,
  DEFAULT_HARNESS_AGENT,
  type SessionId,
} from '@podium/model/browser'
import {
  asThreadId,
  asUserId,
  dedupeSessionsByResume,
  type SuperagentThreadWire,
  superagentThreadRowId,
} from '@podium/model'
import { MobxPool } from '@podium/client-graph'
import {
  CHAT_CONTEXT_ENTITIES,
  CHAT_CONTEXT_SUMMARIES,
} from '@podium/client-graph/chat-context-schema'
import { ChatContextSource } from '@podium/client-graph/chat-context-source'
import { NOTICE_ENTITIES } from '@podium/client-graph/notice-schema'
import { NoticeSource } from '@podium/client-graph/notice-source'
import { createSuperagentSource, SUPERAGENT_ENTITIES } from '@podium/client-graph/superagent'
import {
  createSessionExitSource,
  SESSION_EXIT_SOURCE_KEY,
} from '@podium/client-graph/session-exit-source'
import { SESSION_EXIT_ENTITIES } from '@podium/client-graph/session-exit-schema'
import {
  createSessionExitSource,
  SESSION_EXIT_SOURCE_KEY,
} from '@podium/client-graph/session-exit-source'
import { createSuperagentSource, SUPERAGENT_ENTITIES } from '@podium/client-graph/superagent'
import {
  asThreadId,
  asUserId,
  dedupeSessionsByResume,
  type SuperagentThreadWire,
  superagentThreadRowId,
} from '@podium/model'
import {
  asIssueId,
  asMachineId,
  asMutationId,
  asRepoId,
  asSessionId,
  DEFAULT_HARNESS_AGENT,
  type SessionId,
} from '@podium/model/browser'
import { noticeFixture } from '../../../../tests/worklist/diagnostics/notice-fixture'
import { checkChatContext } from './chat-context-check'

/** Synthetic corpus shared by the focused reader/UI checks. No external app,
 * database, socket or additional mutation owner is constructed. */
export async function createChatContextFixture(resumeTwins = false) {
  const data = noticeFixture()
  const rawSessions = data.sessions.map((row, index) => ({
    ...row,
    privateBody: 'Undeclared cold payload',
    issueId: asIssueId(index ? 'cold-issue' : 'chat-issue'),
    displayRef: index ? 'SYN-2-A' : 'SYN-1-A',
    refRepoId: asRepoId('chat-repo'),
    refSeq: index ? 2 : 1,
    refLetter: 'A',
    machineId: asMachineId('chat-machine'),
    status: index ? ('exited' as const) : ('live' as const),
    archived: index > 0,
    lastActiveAt: index ? '2020-01-01T00:00:00Z' : '2026-10-01T12:00:00Z',
  })) as Store['sessions']
  if (resumeTwins) {
    const cold = rawSessions[1]!
    // Resume twins share the product default harness, as an identifier: the
    // kind is arbitrary fixture data, never vendor behaviour (POD-5614).
    cold.resume = { kind: DEFAULT_HARNESS_AGENT, value: 'synthetic-native-id' }
    rawSessions.push({
      ...cold,
      sessionId: asSessionId('parked-twin'),
      displayRef: 'SYN-2-B',
      refLetter: 'B',
      lastActiveAt: '2021-01-01T00:00:00Z',
    })
    rawSessions.push({
      ...rawSessions[0]!,
      sessionId: asSessionId('active-twin'),
      displayRef: 'SYN-1-B',
      refLetter: 'B',
      resume: { kind: DEFAULT_HARNESS_AGENT, value: 'synthetic-active-id' },
    })
    rawSessions[0]!.resume = { kind: DEFAULT_HARNESS_AGENT, value: 'synthetic-active-id' }
    rawSessions.push({
      ...cold,
      sessionId: asSessionId('headless-twin'),
      displayRef: 'SYN-2-C',
      refLetter: 'C',
      headless: true,
    })
  }
  const sessions = dedupeSessionsByResume(rawSessions)
  const issues = Array.from({ length: 9 }, (_, index) => ({
    id: asIssueId(index === 0 ? 'chat-issue' : index === 1 ? 'cold-issue' : `chat-issue-${index}`),
    seq: index + 1,
    repoId: 'chat-repo',
    repoPath: '/synthetic/project',
    prefix: 'SYN',
    displayRef: `SYN-${index + 1}`,
    title: index === 3 ? 'Other composer task' : 'Synthetic task',
    stage: index === 1 ? 'done' : 'in_progress',
    archived: index === 1,
    deletedAt: index === 8 ? '2026-10-01T12:00:00Z' : null,
    updatedAt: '2026-10-01T12:00:00Z',
    createdAt: '2020-01-01T00:00:00Z',
    worktreePath: index ? null : '/synthetic/project',
    deps: [],
    coordinatorSessionId: index ? undefined : sessions[0]!.sessionId,
    memberSessionIds: sessions
      .filter(
        (row) =>
          row.issueId ===
          (index ? (index === 1 ? 'cold-issue' : `chat-issue-${index}`) : 'chat-issue'),
      )
      .map((row) => row.sessionId),
    panel:
      index === 0
        ? {
            artifacts: [
              {
                path: 'concept.html',
                title: 'Synthetic concept',
                artifactId: 'opaque-artifact',
                entry: 'concept.html',
                addedAt: '2026-10-01T12:00:00Z',
              },
            ],
          }
        : undefined,
  })) as unknown as IssueViewModel[]
  let messages = data.messages,
    interactions = [...data.interactions].reverse()
  let queued = [
    {
      mutationId: asMutationId('held-live'),
      kind: 'sendText',
      input: { sessionId: sessions[0]!.sessionId, text: 'Held synthetic send' },
      queuedAt: 2,
    },
  ]
  let parked = [
    {
      entry: {
        mutationId: asMutationId('held-failed'),
        kind: 'resumeAndSend',
        input: { sessionId: sessions[0]!.sessionId, text: 'Saved synthetic send' },
        queuedAt: 1,
      },
      reason: { code: 'max-age' },
      parkedFrom: 'expired',
      deadLetteredAt: 3,
      attempts: 2,
    },
  ]
  const listeners = new Set<() => void>(),
    outboxListeners = new Set<() => void>(),
    addressed = new Set<(batch: ReplicaAddressedBatch) => void>()
  const counts = { collections: 0, addresses: 0, exits: 0 }
  const exits = new Map<string, 'removed' | 'evicted'>()
  const raw = (kind: string): readonly object[] =>
    kind === 'sessions'
      ? rawSessions
      : kind === 'issueProjections'
        ? issues
        : kind === 'messageRecords'
          ? messages
          : kind === 'pendingInteractions'
            ? interactions
            : []
  const drafts = new DraftStore({
    storage: { get: () => null, set: () => {} },
    hub: {
      on: () => () => {},
      sendDraftEdit: () => {},
      connectionHealth: () => ({ status: 'ok' }),
    } as never,
  })
  drafts.values.set(sessions[0]!.sessionId, 'Saved draft')
  let state: Store
  const owner = withKeyedInputs({
    drafts,
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    readPosition: { get: () => ({ lastEventId: 0, seenAt: null }), subscribe: () => () => {} },
    replica: {
      rows: (kind: string) => {
        counts.collections++
        return raw(kind)
      },
      getCursor: () => 1,
      exitKind: (entity: string, id: string) => {
        counts.exits++
        return entity === 'session' ? exits.get(id) : undefined
      },
      row: (kind: string, id: string) => {
        counts.addresses++
        return raw(kind).find(
          (row) => Reflect.get(row, kind === 'sessions' ? 'sessionId' : 'id') === id,
        )
      },
      subscribeAddressedBatch: (fn: (batch: ReplicaAddressedBatch) => void) => {
        addressed.add(fn)
        return () => {
          addressed.delete(fn)
        }
      },
    },
    outbox: {
      pending: () => queued,
      deadLetters: () => parked,
      subscribe: (fn: () => void) => {
        outboxListeners.add(fn)
        return () => {
          outboxListeners.delete(fn)
        }
      },
    },
  }) as unknown as ClientRuntime
  // My one synced thread record (POD-6675).
  const ownThread: SuperagentThreadWire = {
    threadId: asThreadId('own-thread'),
    ownerUserId: asUserId('operator'),
    kind: 'global',
    title: 'Synthetic thread',
    podiumSessionId: sessions[0]!.sessionId,
    archived: false,
    resumable: false,
    turnRunning: false,
    lastTurnFailure: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  }
  const ownThreadId = superagentThreadRowId(ownThread.ownerUserId, ownThread.threadId)
  state = {
    sessions,
    messageRecords: messages,
    pendingInteractions: interactions,
    issueProjections: issues,
    drafts: { [sessions[0]!.sessionId]: 'Saved draft' },
    attachedSessionId: sessions[1]!.sessionId,
    transcriptReveal: null,
    superagentThreads: [ownThread],
    superThreadId: 'own-thread',
    paneA: null,
    selectedWorktree: null,
    machines: [{ id: 'chat-machine', name: 'Synthetic host', online: true }],
    repos: [{ path: '/synthetic/project', worktrees: [] }],
    chatSendsFor: (id: SessionId) => outboxChatSends(owner.root.services.outbox.queue, id),
    replica: owner.root.replica,
    setSessionDraft: (id: string, text: string) => {
      state = { ...state, drafts: { ...state.drafts, [id]: text } }
      drafts.set(id as SessionId, text)
      for (const fn of listeners) fn()
    },
  } as unknown as Store
  const pool = new MobxPool(
    { coarseNow: Date.parse('2026-10-01T13:00:00Z'), selectedIssueId: null },
    undefined,
    {
      summaries: CHAT_CONTEXT_SUMMARIES,
      load: (entity, id) =>
        (entity === 'issue' ? issues : rawSessions).find(
          (row) => ('id' in row ? row.id : row.sessionId) === id,
        ) as never,
      schedule: () => () => {},
    },
  )
  pool.apply({
    type: 'replace',
    rows: [
      {
        kind: 'repo',
        id: 'chat-repo',
        value: { id: 'chat-repo', repoPath: '/synthetic/project', prefix: 'SYN' } as never,
      },
      ...issues.map((row) => ({ kind: 'issue' as const, id: row.id, value: row as never })),
      ...rawSessions.map((row) => ({
        kind: 'session' as const,
        id: row.sessionId,
        value: row as never,
      })),
      // My synced thread record (POD-6675), its feed id stamped as `id`.
      {
        kind: 'superagentThread' as const,
        id: ownThreadId,
        value: { ...ownThread, id: ownThreadId } as never,
      },
    ],
  })
  // The machine record (with my access row) and its online condition (POD-6644).
  headerEntities(pool).apply([
    ...seedFixtureMachines(pool, state.machines as never),
    { kind: 'repository', id: '/synthetic/project', value: state.repos[0]! },
  ] as never)
  headerEntities(pool).order('machine', ['chat-machine'])
  headerEntities(pool).order('repository', ['/synthetic/project'])
  pool.sources.register(NOTICE_ENTITIES, new NoticeSource(noticeSourcePorts(owner)))
  pool.sources.register(SUPERAGENT_ENTITIES, await createSuperagentSource(superagentSourcePorts(owner)))
  const exitSource = await pool.sources.ensure(SESSION_EXIT_SOURCE_KEY, SESSION_EXIT_ENTITIES, () =>
    createSessionExitSource(replicaSourcePorts(owner)),
  )
  pool.sources.view('test.chatFixture.ui', () => ({ dispose: () => disposeFixtureUi(owner) }))
  const source = new ChatContextSource(chatSourcePorts(owner), pool)
  pool.sources.register(CHAT_CONTEXT_ENTITIES, source)
  const check = (override = state, models = issues.filter((row) => !row.deletedAt)) =>
    checkChatContext(
      pool,
      override,
      models,
      sessions.map((row) => row.sessionId),
    )
  const load = async () => {
    for (let round = 0; round < 6; round++) {
      check()
      await Promise.resolve()
      pool.hydrate()
    }
    return check()
  }
  return {
    pool,
    owner,
    source,
    exitSource,
    counts,
    issues,
    sessions,
    data,
    check,
    load,
    state: () => state,
    addressed,
    listeners,
    outboxListeners,
    updateExit(id: string, kind: 'removed' | 'evicted' | undefined, replace = false) {
      if (kind) exits.set(id, kind)
      else exits.delete(id)
      for (const fn of addressed)
        fn(
          replace
            ? { type: 'replace', reason: 'rescope' }
            : { type: 'update', rows: [{ kind: 'sessions', id }] },
        )
    },
    updateDraft(text: string) {
      state.setSessionDraft(sessions[0]!.sessionId, text)
    },
    updateMessages(next: typeof messages, ids: string[]) {
      messages = next
      state = { ...state, messageRecords: next }
      for (const fn of addressed)
        fn({ type: 'update', rows: ids.map((id) => ({ kind: 'messageRecords', id })) })
    },
    updateInteractions(next: typeof interactions, ids: string[]) {
      interactions = next
      state = { ...state, pendingInteractions: next }
      for (const fn of addressed)
        fn({ type: 'update', rows: ids.map((id) => ({ kind: 'pendingInteractions', id })) })
    },
    discardHeld() {
      queued = []
      parked = []
      for (const fn of outboxListeners) fn()
    },
    deleteIssue() {
      issues[0] = { ...issues[0]!, deletedAt: '2026-10-01T13:00:00Z' }
      pool.apply({
        type: 'update',
        rows: [{ kind: 'issue', id: issues[0]!.id, value: issues[0] as never }],
      })
    },
    replaceEmpty() {
      messages = []
      interactions = []
      state = { ...state, messageRecords: [], pendingInteractions: [] }
      for (const fn of addressed) fn({ type: 'replace', reason: 'rescope' })
    },
  }
}
