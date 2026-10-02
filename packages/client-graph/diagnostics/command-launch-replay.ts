/** Read-only operator replay. Raw rows, cookies and errors stay in memory on
 * ludovico. Output contains only counts and differing field positions. */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { NdjsonLineReader, readSyncStream, SyncStreamFailed } from '@podium/client-core/sync-stream'
import { asIssueId } from '@podium/model/browser'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import { runInAction } from 'mobx'
import { createRuntimeWorklistPool } from '../src/runtime-pool'
import { attachCommandLaunchSource } from '../src/command-launch-source'
import { COMMAND_SUMMARIES } from '../src/command-launch-schema'
import { checkCommandLaunch, poolCommandLaunchSnapshot } from './command-launch-check'
import { corpusFromLive, type LiveCollections } from '../../worklist-proto/harness/src/fixture/live-snapshot'
import { ScenarioCache } from '../../worklist-proto/shared/src/scenarios'
import { sidebarReplayStore } from '../../worklist-proto/harness/src/oracle/sidebar-replay'

let phase = 0
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Replay is restricted to ludovico')
  const origin = process.argv.find(arg => arg.startsWith('--origin='))?.slice(9) ?? 'http://127.0.0.1:18787'
  phase = 1
  const { token } = JSON.parse(readFileSync(join(homedir(), '.podium/cli-session.json'), 'utf8')) as { token: string }
  const cookie = `podium_session=${token}`
  const call = async <T>(path: string, method = 'GET'): Promise<T> => {
    const response = await fetch(`${origin}/trpc/${path}?batch=1${method === 'GET' ? '&input=%7B%7D' : ''}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
    const body = await response.json() as { result?: { data: T } }[]
    if (!response.ok || !body[0]?.result) throw new Error('Read failed')
    return body[0].result.data
  }
  phase = 2
  const cache = new ScenarioCache(), byEntity = new Map<string, unknown[]>()
  const response = await fetch(`${origin}/sync/bootstrap`, { headers: { cookie }, signal: AbortSignal.timeout(120000) })
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) throw new Error('Bootstrap unavailable')
  let operatorWireVersion = 0
  // This offline comparison consumes row fixtures, not a connected client.
  // The installed operator may precede the pilot's wire bump. Normalize only
  // that metadata for the existing strict frame/count parser; row payloads,
  // transfer identity and completion checks retain their actual values.
  async function* fixtureLines() {
    for await (const line of NdjsonLineReader(response.body!)) {
      const record = JSON.parse(line)
      if (record.type === 'syncMeta') {
        operatorWireVersion = record.wireVersion
        yield JSON.stringify({ ...record, wireVersion: CLIENT_WIRE_VERSION })
      } else yield line
    }
  }
  for await (const chunk of readSyncStream(fixtureLines())) {
    if (chunk.type !== 'feedBootstrap') continue
    for (const change of chunk.changes) {
      if (change.op !== 'upsert') continue
      cache.put(change.entity as Parameters<ScenarioCache['put']>[0], change.entityId, change.value)
      const rows = byEntity.get(change.entity) ?? []
      rows.push(change.value); byEntity.set(change.entity, rows)
    }
  }
  phase = 3
  const [scan, pins] = await Promise.all([
    call<{ repositories: LiveCollections['repos']; machines: LiveCollections['machines'] }>('discovery.refreshRepos', 'POST'),
    call<LiveCollections['pins']>('pins.list'),
  ])
  const raw = { issues: byEntity.get('issue') ?? [], issueProjections: byEntity.get('issueProjection') ?? [],
    issueUserStates: byEntity.get('issueUserState') ?? [], issueGitStates: byEntity.get('issueGitState') ?? [],
    sessions: byEntity.get('session') ?? [], repoProjections: byEntity.get('repo') ?? [], issueDeps: byEntity.get('issueDep') ?? [],
    repos: scan.repositories, machines: scan.machines, pins } as LiveCollections
  phase = 4
  const corpus = corpusFromLive(raw, Date.now())
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  let store = { ...sidebarReplayStore(corpus, replica), paletteOpen: true, openIssueId: null, selectedIssueId: null,
    selectedWorktree: null, paneA: null, recentFiles: [], sidebarSettings: {} } as unknown as Store<PodiumClientApi>
  const listeners = new Set<() => void>()
  const runtime = { replica, getSnapshot: () => store, pendingOverlaysByRow: () => new Map(),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const handle = createRuntimeWorklistPool(runtime as unknown as Parameters<typeof createRuntimeWorklistPool>[0], { summaries: COMMAND_SUMMARIES })
  attachCommandLaunchSource(handle.pool, runtime as unknown as Parameters<typeof attachCommandLaunchSource>[1])
  try {
    phase = 5
    let checks = 0, differences = 0, pending = 0, positions = 0
    let first: { check: number; sectionIndex: number; rowIndex: number | null; field: string } | null = null
    const contexts = [null, ...replica.rows('issueProjections').slice(0, 4).map(row => asIssueId(row.id))]
    console.log(JSON.stringify({ phase, issues: corpus.issues.length, sessions: corpus.sessions.length, contexts: contexts.length }))
    for (const selectedIssueId of contexts) {
      store = { ...store, selectedIssueId }
      for (const listener of listeners) listener()
      await Promise.resolve()
      for (let round = 0; round < 64; round++) {
        runInAction(() => poolCommandLaunchSnapshot(handle.pool))
        if (!handle.pool.hydrate()) break
      }
      const result = runInAction(() => checkCommandLaunch(handle.pool, store))
      checks++; differences += result.differences; pending += result.pending; positions += result.rows
      if (!first && result.first) first = { check: checks, sectionIndex: result.first.sectionIndex,
        rowIndex: result.first.rowIndex, field: result.first.field }
      console.log(JSON.stringify({ phase, checks, differences, pending, positions }))
    }
    console.log(JSON.stringify({ issues: corpus.issues.length, sessions: corpus.sessions.length, machines: corpus.machines.length,
      repositories: corpus.repos.length, operatorWireVersion, checks, positions, differences, pending, first }))
    if (differences || pending || !positions) process.exitCode = 1
  } finally { handle.dispose() }
}
if (import.meta.main) main().catch(error => {
  const native = error instanceof Error && ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name) ? error.name : 'replay-failed'
  console.error(JSON.stringify({ failed: 1, phase, reason: error instanceof SyncStreamFailed ? error.reason : native }))
  process.exitCode = 1
})
