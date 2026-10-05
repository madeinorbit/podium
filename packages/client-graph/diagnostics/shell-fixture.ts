import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
/** Synthetic rows only. Used by the focused tests and browser fixture. */
import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReferenceState as Store } from '@podium/client-graph/diagnostics/reference-state'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { emptyWorkspace, openTab, missionRootFor, workspaceKeyFor } from '@podium/client-core/values'
import { asIssueId, asMachineId, asRepoId, asSessionId } from '@podium/model/browser'
import { shipLaneId, type ShipOrderProjection, type ShipLaneProjection } from '@podium/model'
import { MobxPool } from '../src/pool'
import { SHELL_ENTITIES, SHELL_SUMMARIES } from '../src/shell-schema'
import { ShellSource } from '../src/shell-source'


export const SHELL_NOW = Date.parse('2026-10-01T14:00:00Z')
export function shellFixture(count = 40) {
  const stamp = '2026-01-01T00:00:00Z', repoId = asRepoId('shell-repo'), machineId = asMachineId('shell-machine')
  const issues = Array.from({ length: count }, (_, index) => ({ id: asIssueId(`shell-issue-${String(index).padStart(4, '0')}`), seq: index + 1,
    title: `Synthetic task ${index}`, repoId, repoPath: '/synthetic/project', worktreePath: index < 2 ? `/synthetic/project/w${index}` : null,
    parentId: index === 1 ? asIssueId('shell-issue-0000') : null, stage: index >= 20 ? 'done' : 'review', closedReason: null,
    archived: index >= 20, deletedAt: null, color: index === 0 ? 'red' : null, audience: 'human', sortKey: `a${index}`,
    branch: `issue/synthetic-${index}`, gitState: { ahead: 2, merged: false }, createdAt: stamp, updatedAt: stamp,
    description: 'Synthetic body', deps: [], blocked: false, panel: { todos: [], deferred: [], artifacts: [{ path: 'review/index.html', artifactId: 'synthetic-artifact', entry: 'index.html', files: [{ path: 'index.html', size: 3 }] }] },
    prefix: 'SYN', displayRef: `SYN-${index + 1}`, memberSessionIds: [], childIds: [], childCount: 0, childDoneCount: 0,
  })) as unknown as IssueViewModel[]
  const sessions = issues.map((issue, index) => ({ sessionId: asSessionId(`shell-session-${String(index).padStart(4, '0')}`), issueId: issue.id,
    cwd: index === 0 ? '/synthetic/project/w1/deep' : `/synthetic/project/w${index}`, machineId,
    name: `Synthetic agent ${index}`, title: `Synthetic session ${index}`, archived: index >= 20,
    status: index >= 20 ? 'exited' : 'live', agentKind: 'codex', headless: false, createdAt: stamp,
    lastActiveAt: index < 2 ? '2026-10-01T12:00:00Z' : stamp, displayRef: `SYN-${index + 1}A`, agentState: { phase: 'idle', since: stamp },
  })) as unknown as SessionView[]
  const approvals = [0, 1].map(index => ({ id: `shell-approval-${index}`, machineId, machineName: 'Synthetic host', sessionId: sessions[index]!.sessionId,
    issueId: issues[index]!.id, issueSeq: index + 1, issueDisplayRef: `SYN-${index + 1}`, issueTitle: `Synthetic task ${index}`, op: { kind: 'channel', target: 'dev' },
    status: 'pending', createdAt: stamp, decidedAt: null, resultText: null })) as Store['approvals']
  const fileTabs: Store['fileTabs'] = [{ id: 'shell-file', scope: { kind: 'worktree', root: '/synthetic/project/w1', machineId },
    path: 'readme.md', worktreePath: '/synthetic/project/w1', issueId: issues[1]!.id }]
  const workspace = openTab(openTab(emptyWorkspace(`mission:${issues[0]!.id}`), sessions[0]!.sessionId, { permanent: true }), fileTabs[0]!.id, { permanent: true })
  const shipOrders = ['waiting', 'needs_you', 'in_progress', 'shipped'].map((humanState, index) => ({ id: `shell-order-${index}`, issueId: issues[index]!.id,
    repoId, targetBranch: `issue/synthetic-${index}`, destination: 'main', humanState, state: humanState === 'waiting' ? 'queued' : humanState === 'shipped' ? 'completed' : 'held',
    activity: humanState === 'waiting' ? 'waiting' : humanState === 'shipped' ? 'shipped' : 'held', queuedAt: stamp, stateChangedAt: stamp,
    ...(humanState === 'shipped' ? { receiptId: 'shell-receipt' } : {}), queueRank: 99 })) as unknown as ShipOrderProjection[]
  const shipLanes: ShipLaneProjection[] = [{ id: shipLaneId(repoId, 'main'), repoId, destination: 'main', trains: [{ orderIds: [shipOrders[0]!.id] }], blockedOrderIds: [] }]
  let state = { view: 'workspace', paneA: sessions[0]!.sessionId, selectedIssueId: issues[1]!.id, selectedWorktree: '/synthetic/project/w1', reposLoaded: true,
    superOpen: true, paletteOpen: true, autoContinuePromptSessionId: sessions[0]!.sessionId, coarseNow: SHELL_NOW,
    approvals, fileTabs, workspaces: { [workspace.key]: workspace }, sessions, shipOrders, shipLanes,
    machines: [{ id: machineId, name: 'Synthetic host', hostname: 'synthetic', online: true, lastSeenAt: stamp }],
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
    { kind: 'repo', id: repoId, value: { id: repoId, prefix: 'SYN' } },
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })), ...sessions.map(value => ({ kind: 'session' as const, id: value.sessionId, value })),
  ] as never })
  const syncHeader = () => {
    const keepRepos = new Set(state.repos.map(value => JSON.stringify([value.machineId ?? '', value.path])))
    const keepMachines = new Set<string>(state.machines.map(value => value.id))
    const keepOrders = new Set<string>(state.shipOrders.map(value => value.id))
    pool.header.apply([
      ...[...pool.header.tables.repository.keys()].filter(id => !keepRepos.has(id)).map(id => ({ kind: 'repository' as const, id, value: undefined })),
      ...[...pool.header.tables.machine.keys()].filter(id => !keepMachines.has(id)).map(id => ({ kind: 'machine' as const, id, value: undefined })),
      ...[...pool.header.tables.shipOrder.keys()].filter(id => !keepOrders.has(id)).map(id => ({ kind: 'shipOrder' as const, id, value: undefined })),
      ...state.repos.map(value => ({ kind: 'repository' as const, id: JSON.stringify([value.machineId ?? '', value.path]), value })),
      ...state.machines.map(value => ({ kind: 'machine' as const, id: value.id, value })),
      ...state.shipOrders.map(value => ({ kind: 'shipOrder' as const, id: value.id, value })),
    ])
    pool.header.order('repository', state.repos.map(value => JSON.stringify([value.machineId ?? '', value.path])))
    pool.header.order('machine', state.machines.map(value => value.id)); pool.header.order('shipOrder', state.shipOrders.map(value => value.id))
  }
  syncHeader()
  const source = new ShellSource(runtime)
  pool.sources.register(SHELL_ENTITIES, source)
  return { issues, sessions, approvals, fileTabs, shipOrders, shipLanes, pool, source, loads, listeners, addressed,
    state: () => state,
    change(patch: Partial<Store>) { state = { ...state, ...patch }; syncHeader(); for (const listener of listeners) listener() },
    lane(value: ShipLaneProjection | undefined, id = shipLanes[0]!.id) {
      state = { ...state, shipLanes: [...state.shipLanes.filter(row => row.id !== id), ...(value ? [value] : [])] }
      for (const listener of addressed) listener({ type: 'update', rows: [{ kind: 'shipLanes', id }] })
    },
  }
}
