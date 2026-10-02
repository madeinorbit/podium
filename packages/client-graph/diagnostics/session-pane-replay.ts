/** Read-only live bootstrap on ludovico. Auth, rows, paths and texts stay in
 * this process. Only counts, positions and opaque IDs may leave it. */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createKernelReplica, createSideCache, memoryStorage, allIssueViewModels } from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { dedupeSessions, type Store } from '@podium/client-core/engine'
import { NdjsonLineReader, readSyncStream } from '@podium/client-core/sync-stream'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
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
  const sessions = dedupeSessions(sessionViews(replica.rows('sessions'), { userId: users[0]?.userId ?? '',
    userStatesLoaded: replica.sessionUserStatesLoaded?.() ?? true, userStates: users,
    repos: replica.rows('repos'), machines: replica.rows('machines') }))
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
  // Full screen replay is added alongside the completed ownership rule.
}
if (import.meta.main) main().catch(() => { console.log(JSON.stringify({ replay: 'unavailable', phase, httpStatus })); process.exitCode = 1 })
