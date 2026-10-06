import { headerEntities } from '@podium/client-graph/header-entities'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
/** Private bootstrap stays on ludovico. Export counts/positions only. Device
 * drafts, held sends and scoped threads are covered by the synthetic proofs. */
import { readFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { allIssueViewModels } from '../../../tests/worklist/diagnostics/reference/issue-view-models'
import { sessionViews } from '@podium/client-core/session-values'
import { dedupeSessions } from '../../../tests/worklist/diagnostics/reference-state'
import type { ReferenceState as Store } from '../../../tests/worklist/diagnostics/reference-state'
import { NdjsonLineReader, readSyncStream } from '@podium/client-core/sync-stream'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { ChatContextSource } from '@podium/client-graph/chat-context-source'
import { CHAT_CONTEXT_ENTITIES, CHAT_CONTEXT_SUMMARIES } from '@podium/client-graph/chat-context-schema'
import { NoticeSource } from '@podium/client-graph/notice-source'
import { NOTICE_ENTITIES } from '@podium/client-graph/notice-schema'
import { createSuperagentSource, SUPERAGENT_ENTITIES, SUPERAGENT_SUMMARIES } from '@podium/client-graph/superagent'
import { createSessionExitSource, SESSION_EXIT_SOURCE_KEY } from '@podium/client-graph/session-exit-source'
import { SESSION_EXIT_ENTITIES } from '@podium/client-graph/session-exit-schema'
import { ScenarioCache } from '../../../tests/worklist/shared/src/scenarios'
import { checkChatContext } from '../src/features/chat/chat-context-check'


let phase = 0, httpStatus: number | undefined
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Operator replay is ludovico-only')
  phase = 1
  const { token } = JSON.parse(readFileSync(join(homedir(), '.podium/cli-session.json'), 'utf8')) as { token: string }
  const response = await fetch('http://127.0.0.1:18787/sync/bootstrap', { headers: { cookie: `podium_session=${token}` }, signal: AbortSignal.timeout(120000) })
  httpStatus = response.status
  if (!response.ok || !response.body) throw new Error('Bootstrap unavailable')
  const cache = new ScenarioCache()
  async function* lines() {
    for await (const line of NdjsonLineReader(response.body!)) {
      const record = JSON.parse(line)
      yield record.type === 'syncMeta' ? JSON.stringify({ ...record, wireVersion: CLIENT_WIRE_VERSION }) : line
    }
  }
  phase = 2
  for await (const chunk of readSyncStream(lines())) if (chunk.type === 'feedBootstrap')
    for (const change of chunk.changes) if (change.op === 'upsert') cache.put(change.entity as Parameters<ScenarioCache['put']>[0], change.entityId, change.value)
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const users = replica.rows('sessionUserStates')
  if (new Set(users.map(row => row.userId)).size > 1) throw new Error('Ambiguous replay principal')
  const sessions = dedupeSessions(sessionViews(replica.rows('sessions'), { userId: users[0]?.userId ?? '',
    userStatesLoaded: replica.sessionUserStatesLoaded?.() ?? true, userStates: users,
    repos: replica.rows('repos'), machines: replica.rows('machines') }))
  const issues = allIssueViewModels(replica), messages = replica.rows('messageRecords'), interactions = replica.rows('pendingInteractions')
  const repos = replica.rows('repos').flatMap(row => row.repoPath ? [{ path: row.repoPath }] : [])
  const outbox = { pending: () => [], deadLetters: () => [], subscribe: () => () => {} }
  const state = { replica, sessions, machines: replica.rows('machines'), repos, issueProjections: replica.rows('issueProjections'),
    issueUserStates: replica.rows('issueUserStates'), messageRecords: messages, pendingInteractions: interactions,
    coarseNow: Date.now(), selectedIssueId: null, panelMode: {}, dockShells: {}, pendingSpawnIds: new Set(),
    drafts: {}, attachedSessionId: null, transcriptReveal: null, superThreads: [], superThreadId: null,
    selectedWorktree: null, paneA: null, chatSendsFor: () => [],
  } as unknown as Store
  const runtime = withKeyedInputs({ replica, outbox, getSnapshot: () => state, subscribe: () => () => {},
    readPosition: { get: () => ({ lastEventId: 0, seenAt: null }), subscribe: () => () => {} } })
  phase = 3
  const handle = createRuntimeWorklistPool(runtime as Parameters<typeof createRuntimeWorklistPool>[0], {
    summaries: { issue: CHAT_CONTEXT_SUMMARIES.issue, session: [...CHAT_CONTEXT_SUMMARIES.session, ...SUPERAGENT_SUMMARIES.session] },
  })
  const pool = handle.pool
  pool.sources.register(NOTICE_ENTITIES, new NoticeSource(runtime as never))
  pool.sources.register(SUPERAGENT_ENTITIES, await createSuperagentSource(runtime as never))
  await pool.sources.ensure(SESSION_EXIT_SOURCE_KEY, SESSION_EXIT_ENTITIES, () => createSessionExitSource(runtime))
  const source = new ChatContextSource(runtime as never, pool)
  pool.sources.register(CHAT_CONTEXT_ENTITIES, source)
  headerEntities(pool).apply([...state.machines.map(row => ({ kind: 'machine' as const, id: row.id, value: row })),
    ...repos.map(row => ({ kind: 'repository' as const, id: row.path, value: row as never }))])
  headerEntities(pool).order('machine', state.machines.map(row => row.id)); headerEntities(pool).order('repository', repos.map(row => row.path))
  const ids = [...new Set([...sessions.slice(0, 12).map(row => row.sessionId), ...messages.map(row => row.sessionId), ...interactions.map(row => row.sessionId)])]
  try {
    let result = checkChatContext(pool, state, issues, ids, ['', 'POD', 'task', '1'])
    for (let round = 0; result.pending && round < 64; round++) {
      await Promise.resolve(); pool.hydrate(); result = checkChatContext(pool, state, issues, ids, ['', 'POD', 'task', '1'])
    }
    phase = 4
    console.log(JSON.stringify({ phase, sessions: sessions.length, issues: issues.length, messages: messages.length,
      interactions: interactions.length, addressedSessions: ids.length, deviceLocalReplay: 0, scopedThreadReplay: 0, ...source.counts, ...result }))
    if (!sessions.length || !issues.length || result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose() }
}
if (import.meta.main) main().catch((error: unknown) => {
  console.log(JSON.stringify({ replay: 'unavailable', phase, httpStatus, name: error instanceof Error ? error.name : 'unknown' }))
  process.exitCode = 1
})
