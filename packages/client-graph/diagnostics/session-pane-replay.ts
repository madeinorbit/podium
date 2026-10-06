import { headerEntities } from '@podium/client-graph/header-entities'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
/** Read-only live bootstrap on ludovico. Auth, rows, paths and texts stay in
 * this process. Only counts, positions and opaque IDs may leave it. */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import { dedupeSessions } from '@podium/client-graph/diagnostics/reference-state'
import type { ReferenceState as Store } from '@podium/client-graph/diagnostics/reference-state'
import { NdjsonLineReader, readSyncStream } from '@podium/client-core/sync-stream'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import { createRuntimeWorklistPool } from '../src/runtime-pool'
import { createRowSource } from '../src/shared/row-source'
import { SessionPaneSource } from '../src/session-pane-source'
import { SESSION_PANE_ENTITIES, SESSION_PANE_SUMMARIES } from '../src/session-pane-schema'
import { checkSessionPanes } from './session-pane-check'
import { ScenarioCache } from '../../worklist-proto/shared/src/scenarios'


let phase = 0
let httpStatus: number | undefined
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Operator replay is ludovico-only')
  phase = 1
  const origin = process.argv.find(arg => arg.startsWith('--origin='))?.slice(9) ?? 'http://127.0.0.1:18787'
  const { token } = JSON.parse(readFileSync(join(homedir(), '.podium/cli-session.json'), 'utf8')) as { token: string }
  const response = await fetch(`${origin}/sync/bootstrap`, { headers: { cookie: `podium_session=${token}` }, signal: AbortSignal.timeout(120000) })
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
  for await (const chunk of readSyncStream(lines())) {
    if (chunk.type !== 'feedBootstrap') continue
    for (const change of chunk.changes) if (change.op === 'upsert')
      cache.put(change.entity as Parameters<ScenarioCache['put']>[0], change.entityId, change.value)
  }
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const users = replica.rows('sessionUserStates')
  if (new Set(users.map(row => row.userId)).size > 1) throw new Error('Ambiguous replay principal')
  const sessionReader = createRowSource(withKeyedInputs({ principal: { userId: users[0]?.userId ?? '' },
    getSnapshot: () => ({ repos: [] }), subscribe: () => () => {},
  }), replica, { mode: 'truth' })
  let sessions: Store['sessions']
  try {
    sessions = dedupeSessions(sessionReader.source.snapshot('session').map(row => row.value as Store['sessions'][number]))
  } finally { sessionReader.dispose() }
  const issues = allIssueViewModels(replica)
  phase = 3
  let multipleMatches = 0, differentTies = 0
  for (const session of sessions) {
    const matches = issues.filter(issue => !issue.archived && !issue.deletedAt &&
      (session.issueId === issue.id || (issue.worktreePath !== null &&
        (session.cwd === issue.worktreePath || session.cwd.startsWith(`${issue.worktreePath}/`)))))
    if (matches.length < 2) continue
    multipleMatches++
    const preferred = matches.find(issue => issue.id === session.issueId) ??
      [...matches].sort((a, b) => (b.worktreePath?.length ?? 0) - (a.worktreePath?.length ?? 0))[0]
    if (preferred?.id !== matches[0]?.id) differentTies++
  }
  console.log(JSON.stringify({ phase, sessions: sessions.length, issues: issues.length, multipleMatches, differentTies }))
  if (!sessions.length || !issues.length) process.exitCode = 1
  if (process.argv.includes('--audit-only')) return
  phase = 4
  const state = { sessions, machines: replica.rows('machines'), repos: [], issueProjections: replica.rows('issueProjections'),
    issueUserStates: replica.rows('issueUserStates'), coarseNow: Date.now(), selectedIssueId: null,
    panelMode: {}, dockShells: {}, reposLoaded: true, pendingSpawnIds: new Set(),
  } as unknown as Store
  const runtime = withKeyedInputs({ replica, getSnapshot: () => state, subscribe: () => () => {} })
  const handle = createRuntimeWorklistPool(runtime as Parameters<typeof createRuntimeWorklistPool>[0], { summaries: SESSION_PANE_SUMMARIES })
  const pool = handle.pool
  pool.sources.register(SESSION_PANE_ENTITIES, new SessionPaneSource(runtime as never))
  headerEntities(pool).apply(state.machines.map(row => ({ kind: 'machine', id: row.id, value: row })))
  headerEntities(pool).order('machine', state.machines.map(row => row.id))
  try {
    let result = checkSessionPanes(pool, state, undefined, issues)
    for (let round = 0; result.pending && round < 64; round++) {
      pool.hydrate()
      result = checkSessionPanes(pool, state, undefined, issues)
    }
    phase = 5
    console.log(JSON.stringify({ phase, sessions: sessions.length, issues: issues.length, ...result }))
    if (result.differences || result.pending) process.exitCode = 1
  } finally { handle.dispose() }
}
if (import.meta.main) main().catch((error: unknown) => {
  // Classification only; fetch errors may contain private URLs in their message.
  const name = error instanceof Error ? error.name : 'unknown'
  const cause = error instanceof Error ? error.cause : undefined
  const code = cause && typeof cause === 'object' ? Reflect.get(cause, 'code') : undefined
  const transport = ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(code) ? code : undefined
  console.log(JSON.stringify({ replay: 'unavailable', phase, httpStatus, name, transport }))
  process.exitCode = 1
})
