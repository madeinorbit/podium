/** Ludovico-only read-side operator replay. All payloads and credentials stay
 * in process memory; only aggregate counts and numeric positions are printed. */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { Store } from '@podium/client-core/engine'
import { dedupeSessions } from '@podium/client-core/engine'
import { createKernelReplica, createSideCache, memoryStorage, allIssueViewModels } from '@podium/client-core/replica'
import { NdjsonLineReader, readSyncStream } from '@podium/client-core/sync-stream'
import { emptyWorkspace, missionRootFor, workspaceKeyFor } from '@podium/client-core/viewmodels'
import { asIssueId } from '@podium/model/browser'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import { runInAction } from 'mobx'
import { ScenarioCache } from '../../worklist-proto/shared/src/scenarios'
import { corpusFromLive, type LiveCollections } from '../../worklist-proto/harness/src/fixture/live-snapshot'
import { sidebarReplayStore } from '../../worklist-proto/harness/src/oracle/sidebar-replay'
import { createRuntimeWorklistPool } from '../src/runtime-pool'
import { createRowSource } from '../src/shared/row-source'
import { ShellSource } from '../src/shell-source'
import { SHELL_ENTITIES, SHELL_SOURCE_KEY, SHELL_SUMMARIES } from '../src/shell-schema'
import { MISSION_VIEW_SUMMARIES } from '../src/mission-view-schema'
import { checkShell, poolShellSnapshot } from './shell-check'
import { withKeyedInputs } from '@podium/client-core/engine'

let phase = 0
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Replay is restricted to ludovico')
  const origin = process.argv.find(arg => arg.startsWith('--origin='))?.slice(9) ?? 'http://127.0.0.1:18787'
  const { token } = JSON.parse(readFileSync(join(homedir(), '.podium/cli-session.json'), 'utf8')) as { token: string }
  const cookie = `podium_session=${token}`
  phase = 1
  const cache = new ScenarioCache(), byEntity = new Map<string, unknown[]>()
  const response = await fetch(`${origin}/sync/bootstrap`, { headers: { cookie }, signal: AbortSignal.timeout(120000) })
  if (!response.ok || !response.body) throw new Error('Bootstrap unavailable')
  let operatorWireVersion = 0
  async function* fixtureLines() {
    for await (const line of NdjsonLineReader(response.body!)) {
      const value = JSON.parse(line)
      if (value.type === 'syncMeta') { operatorWireVersion = value.wireVersion; yield JSON.stringify({ ...value, wireVersion: CLIENT_WIRE_VERSION }) }
      else yield line
    }
  }
  for await (const chunk of readSyncStream(fixtureLines())) {
    if (chunk.type !== 'feedBootstrap') continue
    for (const change of chunk.changes) if (change.op === 'upsert') {
      cache.put(change.entity as Parameters<ScenarioCache['put']>[0], change.entityId, change.value)
      const values = byEntity.get(change.entity) ?? []
      values.push(change.value); byEntity.set(change.entity, values)
    }
  }
  // Discovery refresh is the same read-side scan used by the prior reader
  // replays. It neither authors rows nor touches the operator's window state.
  phase = 2
  const scanResponse = await fetch(`${origin}/trpc/discovery.refreshRepos?batch=1`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) })
  const scan = (await scanResponse.json() as { result?: { data: { repositories: LiveCollections['repos']; machines: LiveCollections['machines'] } } }[])[0]?.result?.data
  if (!scanResponse.ok || !scan) throw new Error('Discovery unavailable')
  const corpus = corpusFromLive({ issues: [], issueProjections: byEntity.get('issueProjection') ?? [],
    issueUserStates: byEntity.get('issueUserState') ?? [], issueGitStates: byEntity.get('issueGitState') ?? [],
    sessions: byEntity.get('session') ?? [], repoProjections: byEntity.get('repo') ?? [], issueDeps: byEntity.get('issueDep') ?? [],
    repos: scan.repositories, machines: scan.machines, pins: { repos: [], worktrees: [], panels: [] } } as LiveCollections, Date.now())
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const users = replica.rows('sessionUserStates')
  if (new Set(users.map(row => row.userId)).size > 1) throw new Error('Ambiguous principal')
  const sessionReader = createRowSource(withKeyedInputs({ principal: { userId: users[0]?.userId ?? '' },
    getSnapshot: () => ({ repos: [] }), subscribe: () => () => {}, pendingOverlaysByRow: () => new Map(),
  }), replica, { mode: 'truth' })
  let sessions: Store['sessions']
  try {
    sessions = dedupeSessions(sessionReader.source.snapshot('session').map(row => row.value as Store['sessions'][number]))
  } finally { sessionReader.dispose() }
  const lifecycle = { sessionDefaults: { agent: 'codex' }, hibernation: { enabled: false }, worktreeGc: { enabled: false, afterDays: 14 } }
  let state = { ...sidebarReplayStore(corpus, replica), sessions, view: 'workspace', paneA: sessions[0]?.sessionId ?? null,
    reposLoaded: true, superOpen: false, paletteOpen: false, autoContinuePromptSessionId: null,
    selectedWorktree: null, approvals: [], fileTabs: [], workspaces: {},
    shipOrders: replica.rows('shipOrders'), shipLanes: replica.rows('shipLanes'),
    trpc: { quota: { summary: { query: async () => [] } }, settings: { get: { query: async () => lifecycle } } },
    workspaceKey() {
      const issues = allIssueViewModels(replica, state.issueProjections, state.issueUserStates)
      const selected = issues.find(issue => issue.id === state.selectedIssueId && !issue.archived && !issue.deletedAt)
      return workspaceKeyFor({ missionRootId: selected ? missionRootFor(issues, selected.id)?.id : null, issueId: state.selectedIssueId, worktreePath: state.selectedWorktree })
    },
  } as unknown as Store
  const listeners = new Set<() => void>()
  const runtime = withKeyedInputs({ replica, principal: { userId: users[0]?.userId ?? '' }, getSnapshot: () => state, pendingOverlaysByRow: () => new Map(),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    hostMetrics: { getSnapshot: () => [], subscribe: () => () => {} }, hub: { connectionHealth: () => ({}), onConnectionHealth: () => () => {} } })
  const handle = createRuntimeWorklistPool(runtime as never, { header: true, summaries: {
    issue: [...SHELL_SUMMARIES.issue, ...MISSION_VIEW_SUMMARIES.issue], session: [...SHELL_SUMMARIES.session, ...MISSION_VIEW_SUMMARIES.session],
  } })
  await handle.pool.sources.ensure(SHELL_SOURCE_KEY, SHELL_ENTITIES, () => new ShellSource(runtime as never))
  try {
    phase = 3
    let checks = 0, differences = 0, pending = 0, positions = 0
    let first: ReturnType<typeof checkShell>['first'] = null
    const contexts = [null, ...replica.rows('issueProjections').filter(row => !row.archived && !row.deletedAt).slice(0, 6).map(row => asIssueId(row.id))]
    for (const selectedIssueId of contexts) {
      state = { ...state, selectedIssueId, paletteOpen: Boolean(selectedIssueId), superOpen: Boolean(selectedIssueId), autoContinuePromptSessionId: selectedIssueId ? sessions[0]?.sessionId ?? null : null }
      const key = state.workspaceKey()
      state.workspaces = { [key]: emptyWorkspace(key) }
      for (const listener of listeners) listener()
      await Promise.resolve()
      for (let round = 0; round < 128; round++) { runInAction(() => poolShellSnapshot(handle.pool)); if (!handle.pool.hydrate()) break }
      if (process.argv.includes('--red-control')) {
        // A wrong pool-only window row, entirely in memory, must go red.
        const source = await handle.pool.sources.ensure(SHELL_SOURCE_KEY, SHELL_ENTITIES, () => new ShellSource({} as never))
        const original = source.read.bind(source)
        source.read = ((entity: string, id: string) => entity === 'shellWindow' ? { ...original(entity as never, id) as object, paletteOpen: !state.paletteOpen } : original(entity as never, id)) as typeof source.read
      }
      const result = runInAction(() => checkShell(handle.pool, state))
      checks++; differences += result.differences; pending += result.pending; positions += result.positions; first ??= result.first
    }
    console.log(JSON.stringify({ issues: corpus.issues.length, sessions: sessions.length, machines: scan.machines.length, repositories: scan.repositories.length,
      orders: state.shipOrders.length, lanes: state.shipLanes.length, operatorWireVersion, checks, positions, differences, pending, first,
      windowControls: 'in-memory', fileLayouts: 'in-memory' }))
    if (differences || pending || !positions) process.exitCode = 1
  } finally { handle.dispose() }
}
if (import.meta.main) main().catch(() => { console.error(JSON.stringify({ unavailable: 1, phase })); process.exitCode = 1 })
