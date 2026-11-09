import type { AgentConcurrencyHistoryResult, PodiumClientApi } from '@podium/client-core/api'
import type { ConnectionCondition } from '@podium/client-core/live'
import type { HostLifecycle } from '@podium/client-graph/instance-preferences'
import {
  buildFlightDeckRows, createHostSessionAggregatesSelector, cwdInWorktree, issueForCwd,
  missionProgress,
  reposToViews, resolveActiveWorktree, selectedMissionRoot, shippingPanelModel,
} from '@podium/client-core/values'
import { headerView } from '@podium/client-graph/header-views'
import type { MobxPool } from '@podium/client-graph/pool'
import { type HostMetricsWire, isAgentConfirmedComputing, isMachineOfflineForLiveTerminal, type MachineQuotaWire } from '@podium/model/browser'
import { allIssueViewModels } from './reference/issue-view-models'
/** Diagnostic-only side-by-side value check. Values stay in this process;
 * reports contain comparison positions and field names, never payloads. */
import type { ReferenceState as Store } from './reference-state'
import { compareSidebarSnapshots, type SidebarSnapshot } from './sidebar-check'

export interface HeaderCheckInputs {
  metrics: readonly HostMetricsWire[]
  quotas: readonly MachineQuotaWire[]
  connection: ConnectionCondition | undefined
  history?: AgentConcurrencyHistoryResult
  lifecycle?: HostLifecycle
  /** The LiveStore's unsent-write count (POD-5798). */
  outboxSize?: number
  /** Machines the LiveStore knows online: never listed offline (POD-5798). */
  liveOnline?: readonly string[]
}
const roster = (sessions: ReturnType<ReturnType<typeof headerView>['working']>) => sessions.map((session) => ({
  sessionId: session.sessionId, name: session.name ?? null, title: session.title,
  displayRef: session.displayRef ?? null, agentKind: session.agentKind ?? null,
}))
const selected = (issue: { id: string; title: string; seq: number; stage: string; displayRef?: string } | undefined) =>
  issue ? { id: issue.id, title: issue.title, seq: issue.seq, stage: issue.stage, displayRef: issue.displayRef ?? `#${issue.seq}` } : null
// What the header shows of a machine (POD-6644: the pool's are live models).
const machineView = (rows: readonly { id: string; name: string; online: boolean; hostname?: string; lastSeenAt?: string }[]) =>
  rows.map(({ id, name, online, hostname, lastSeenAt }) => ({ id, name, online, hostname: hostname ?? null, lastSeenAt: lastSeenAt ?? null }))
function sections(values: Record<string, unknown>, pending = 0): SidebarSnapshot {
  return { pending, sections: Object.entries(values).map(([key, value]) => ({ key, fields: { value }, rows: [] })) }
}

export function poolHeaderSnapshot(pool: MobxPool): SidebarSnapshot {
  const view = headerView(pool), folded = view.folded(), metrics = view.metrics()
  return sections({
    view: view.row('window', 'window')?.view ?? 'workspace',
    working: roster(view.working()), selected: selected(typeof view.selectedIssue() === 'symbol' ? undefined : view.selectedIssue() as Exclude<ReturnType<typeof view.selectedIssue>, symbol>),
    machines: machineView(view.machines()), metrics, quotas: view.quotas(), connection: view.connection() ?? null,
    aggregates: metrics.map((metric) => view.aggregate(metric.machineId)),
    folded: { root: selected(folded.root), progress: folded.progress, live: folded.live, working: folded.working, needs: folded.needs },
    shipping: view.shipping(),
    history: view.history(), lifecycle: view.lifecycle(),
    outboxSize: pool.live?.outbox.pending ?? 0,
    offline: machineView(view.offlineMachines()),
  }, (folded.loading ? 1 : 0) + (typeof view.selectedIssue() === 'symbol' ? 1 : 0))
}

export function legacyHeaderSnapshot(store: Store<PodiumClientApi>, inputs: HeaderCheckInputs, now = store.coarseNow): SidebarSnapshot {
  const issues = allIssueViewModels(store.replica, store.issueProjections ?? [], store.issueUserStates), sessions = store.sessions
  const root = selectedMissionRoot(issues, sessions, store.selectedIssueId)
  const first = root ? buildFlightDeckRows(issues, sessions, root.id)[0] : undefined
  const aggregates = createHostSessionAggregatesSelector()(sessions)
  const active = resolveActiveWorktree({ paneA: store.paneA, fileTabs: store.fileTabs, sessions })
  let repoId: string | null = null, scanned = false
  if (active) {
    for (const repo of reposToViews(store.repos)) {
      const lane = repo.worktrees.filter((lane) => (!active.machineId || !lane.machineId || lane.machineId === active.machineId) && cwdInWorktree(active.cwd, lane.path)).sort((a, b) => b.path.length - a.path.length)[0]
      if (lane) { repoId = repo.repoId ?? lane.repoId ?? null; scanned = true; break }
    }
    if (!scanned) {
      const id = active.issueId ?? sessions.find((session) => session.sessionId === active.sessionId)?.issueId
      repoId = (id ? issues.find((issue) => issue.id === id) : issueForCwd(issues, active.cwd))?.repoId ?? null
    }
  }
  const shipping = shippingPanelModel(store.shipOrders ?? [], issues, repoId)
  const working = sessions.filter((session) => isAgentConfirmedComputing(session, now))
  const history = inputs.history ? { ...inputs.history, peak: Math.max(inputs.history.peak, working.length),
    buckets: inputs.history.buckets.map((bucket: AgentConcurrencyHistoryResult['buckets'][number], index: number) => index === inputs.history!.buckets.length - 1 ? { ...bucket, count: Math.max(bucket.count, working.length) } : bucket) } : null
  return sections({ view: store.view ?? 'workspace', working: roster(sessions.filter((session) => isAgentConfirmedComputing(session, now))),
    selected: selected(issues.find((issue) => issue.id === store.selectedIssueId && !issue.deletedAt)),
    machines: machineView(store.machines), metrics: inputs.metrics, quotas: inputs.quotas, connection: inputs.connection ?? null,
    aggregates: inputs.metrics.map((metric) => aggregates.forMachine(metric.machineId)),
    folded: { root: selected(root), progress: missionProgress(issues, sessions, root?.id), live: first?.liveAgentCount ?? 0, working: first?.workingAgentCount ?? 0, needs: first?.actionableCount ?? 0 },
    shipping: { unfinishedCount: shipping.unfinishedCount, decisionCount: shipping.decisionCount },
    history, lifecycle: inputs.lifecycle ?? null, outboxSize: inputs.outboxSize ?? 0,
    offline: machineView(store.machines.filter((machine) => {
      if (!isMachineOfflineForLiveTerminal(machine) || inputs.liveOnline?.includes(machine.id)) return false
      if (machine.serviceAssignment?.agentExecution === false || machine.revokedAt || machine.supersededBy) return false
      const seen = Date.parse(machine.lastSeenAt ?? '')
      return Number.isFinite(seen) && now - seen <= 7 * 86_400_000
    })),
  })
}
export function checkHeader(pool: MobxPool, store: Store<PodiumClientApi>, inputs: HeaderCheckInputs) {
  return compareSidebarSnapshots(legacyHeaderSnapshot(store, inputs, pool.clock.current), poolHeaderSnapshot(pool))
}
