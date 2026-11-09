import { disposeFixtureUi } from '@podium/client-core/test-support/ui'
import { patchFixtureScreen } from '@podium/client-core/test-support/ui'
import { createPoolNavigationProvider } from '@podium/client-graph/navigation-provider'
/** Synthetic rows only. Used by the focused tests and browser fixture. */
import type { ClientRuntime } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { activateTab, emptyWorkspace, missionRootFor, openTab, workspaceKeyFor } from '@podium/client-core/values'
import { headerEntities } from '@podium/client-graph/header-entities'
import { liveFixture, seedFixtureMachines } from '@podium/client-graph/live-fixture'
import { MobxPool } from '@podium/client-graph/pool'
import { SHELL_ENTITIES, SHELL_SUMMARIES } from '@podium/client-graph/shell-schema'
import { ShellSource } from '@podium/client-graph/shell-source'
import { type ShipLaneProjection, type ShipOrderProjection, shipLaneId } from '@podium/model'
import { asIssueId, asMachineId, asRepoId, asSessionId, DEFAULT_HARNESS_AGENT } from '@podium/model/browser'
import type { ReferenceState as Store } from './reference-state'


export const SHELL_NOW = Date.parse('2026-10-01T14:00:00Z')
export function shellFixture(count = 40) {
  const stamp = '2026-01-01T00:00:00Z', repoId = asRepoId('shell-repo'), machineId = asMachineId('shell-machine')
  const issues = Array.from({ length: count }, (_, index) => ({ id: asIssueId(`shell-issue-${String(index).padStart(4, '0')}`), seq: index + 1,
    title: `Synthetic task ${index}`, repoId, repoPath: '/synthetic/project', worktreePath: index < 2 ? `/synthetic/project/w${index}` : null,
    parentId: index === 1 ? asIssueId('shell-issue-0000') : null, stage: index >= 20 ? 'done' : 'review', closedReason: null,
    archived: index >= 20, deletedAt: null, audience: 'human', sortKey: `a${index}`,
    branch: `issue/synthetic-${index}`, gitState: { ahead: 2, merged: false }, createdAt: stamp, updatedAt: stamp,
    description: 'Synthetic body', deps: [], blocked: false, panel: { todos: [], deferred: [], artifacts: [{ path: 'review/index.html', artifactId: 'synthetic-artifact', entry: 'index.html', files: [{ path: 'index.html', size: 3 }] }] },
    prefix: 'SYN', displayRef: `SYN-${index + 1}`, memberSessionIds: [], childIds: [], childCount: 0, childDoneCount: 0,
  })) as unknown as IssueViewModel[]
  const sessions = issues.map((issue, index) => ({ sessionId: asSessionId(`shell-session-${String(index).padStart(4, '0')}`), issueId: issue.id,
    cwd: index === 0 ? '/synthetic/project/w1/deep' : `/synthetic/project/w${index}`, machineId,
    refRepoId: repoId, refSeq: index + 1, refLetter: 'A',
    name: `Synthetic agent ${index}`, title: `Synthetic session ${index}`, archived: index >= 20,
    status: index >= 20 ? 'exited' : 'live', agentKind: DEFAULT_HARNESS_AGENT, headless: false, createdAt: stamp,
    lastActiveAt: index < 2 ? '2026-10-01T12:00:00Z' : stamp, displayRef: `SYN-${index + 1}-A`, agentState: { phase: 'idle', since: stamp },
  })) as unknown as SessionView[]
  const fileTabs: Store['fileTabs'] = [{ id: 'shell-file', scope: { kind: 'worktree', root: '/synthetic/project/w1', machineId },
    path: 'readme.md', worktreePath: '/synthetic/project/w1', issueId: issues[1]!.id }]
  const workspace = activateTab(openTab(openTab(emptyWorkspace(`mission:${issues[0]!.id}`), sessions[0]!.sessionId, { permanent: true }), fileTabs[0]!.id, { permanent: true }), sessions[0]!.sessionId)
  const shipOrders = ['waiting', 'needs_you', 'in_progress', 'shipped'].map((humanState, index) => ({ id: `shell-order-${index}`, issueId: issues[index]!.id,
    repoId, targetBranch: `issue/synthetic-${index}`, destination: 'main', humanState, state: humanState === 'waiting' ? 'queued' : humanState === 'shipped' ? 'completed' : 'held',
    activity: humanState === 'waiting' ? 'waiting' : humanState === 'shipped' ? 'shipped' : 'held', queuedAt: stamp, stateChangedAt: stamp,
    ...(humanState === 'shipped' ? { receiptId: 'shell-receipt' } : {}), queueRank: 99 })) as unknown as ShipOrderProjection[]
  const shipLanes: ShipLaneProjection[] = [{ id: shipLaneId(repoId, 'main'), repoId, destination: 'main', trains: [{ orderIds: [shipOrders[0]!.id] }], blockedOrderIds: [] }]
  let state = { view: 'workspace', paneA: sessions[0]!.sessionId, selectedIssueId: issues[1]!.id, selectedWorktree: '/synthetic/project/w1', reposLoaded: true,
    superOpen: true, paletteOpen: true, autoContinuePromptSessionId: sessions[0]!.sessionId, coarseNow: SHELL_NOW,
    fileTabs, workspaces: { [workspace.key]: workspace }, sessions, shipOrders, shipLanes,
    machines: [{ id: machineId, name: 'Synthetic host', hostname: 'synthetic', online: true, lastSeenAt: stamp, use: 'granted' }],
    repos: [{ repoId, path: '/synthetic/project', machineId, kind: 'repository', branch: 'main', worktrees: [{ path: '/synthetic/project/w1', branch: 'issue/synthetic-1' }] }],
    workspaceKey: () => { const selected = issues.find(issue => issue.id === state.selectedIssueId && !issue.archived && !issue.deletedAt); return workspaceKeyFor({ missionRootId: selected ? missionRootFor(issues, selected.id)?.id : null, issueId: state.selectedIssueId, worktreePath: state.selectedWorktree }) },
  } as unknown as Store
  const listeners = new Set<() => void>(), addressed = new Set<(batch: { type: 'update' | 'replace'; rows: { kind: 'shipLanes'; id: string }[] }) => void>()
  const runtime = withKeyedInputs({ getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    replica: { rows: () => state.shipLanes, row: (_kind: string, id: string) => state.shipLanes.find(lane => lane.id === id),
      subscribeAddressedBatch: (listener: typeof addressed extends Set<infer T> ? T : never) => { addressed.add(listener); return () => { addressed.delete(listener) } } },
  }) as unknown as ClientRuntime
  const loads: string[] = []
  const pool = new MobxPool({ coarseNow: SHELL_NOW, selectedIssueId: state.selectedIssueId }, undefined, { summaries: SHELL_SUMMARIES, schedule: () => () => {},
    load: (entity, id) => { loads.push(`${entity}:${id}`); return entity === 'issue' ? issues.find(row => row.id === id) : entity === 'session' ? sessions.find(row => row.sessionId === id) : undefined } })
  pool.apply({ type: 'replace', rows: [
    { kind: 'repo', id: repoId, value: { id: repoId, prefix: 'SYN', repoPath: '/synthetic/project' } },
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })), ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
  ] as never })
  state = { ...state, navigation: createPoolNavigationProvider(pool) }
  pool.sources.view('test.shellFixture.ui', () => ({ dispose: () => disposeFixtureUi(runtime) }))
  const syncHeader = () => {
    const keepRepos = new Set(state.repos.map(value => JSON.stringify([value.machineId ?? '', value.path])))
    const keepMachines = new Set<string>(state.machines.map(value => value.id))
    const keepOrders = new Set<string>(state.shipOrders.map(value => value.id))
    headerEntities(pool).apply([
      ...[...headerEntities(pool).tables.repository.keys()].filter(id => !keepRepos.has(id)).map(id => ({ kind: 'repository' as const, id, value: undefined })),
      ...[...headerEntities(pool).tables.machine.keys()].filter(id => !keepMachines.has(id)).map(id => ({ kind: 'machine' as const, id, value: undefined })),
      ...[...headerEntities(pool).tables.shipOrder.keys()].filter(id => !keepOrders.has(id)).map(id => ({ kind: 'shipOrder' as const, id, value: undefined })),
      ...state.repos.map(value => ({ kind: 'repository' as const, id: JSON.stringify([value.machineId ?? '', value.path]), value })),
      ...(seedFixtureMachines(pool, state.machines) as never[]),
      ...state.shipOrders.map(value => ({ kind: 'shipOrder' as const, id: value.id, value })),
    ])
    headerEntities(pool).order('repository', state.repos.map(value => JSON.stringify([value.machineId ?? '', value.path])))
    headerEntities(pool).order('machine', state.machines.map(value => value.id)); headerEntities(pool).order('shipOrder', state.shipOrders.map(value => value.id))
  }
  syncHeader()
  // Online and presence are a LiveStore condition (ADR 12 D1, POD-5798), not
  // record fields: syncHeader wrote the reference machine's facts there.
  const live = liveFixture(pool, () => SHELL_NOW)
  const source = new ShellSource(runtime)
  pool.sources.register(SHELL_ENTITIES, source)
  return { issues, sessions, fileTabs, shipOrders, shipLanes, pool, live, source, loads, listeners, addressed,
    state: () => state,
    change(patch: Partial<Store>) { state = patchFixtureScreen(state, patch); syncHeader(); for (const listener of listeners) listener() },
    lane(value: ShipLaneProjection | undefined, id = shipLanes[0]!.id) {
      state = { ...state, shipLanes: [...state.shipLanes.filter(row => row.id !== id), ...(value ? [value] : [])] }
      for (const listener of addressed) listener({ type: 'update', rows: [{ kind: 'shipLanes', id }] })
    },
  }
}
