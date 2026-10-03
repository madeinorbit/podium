import type { SessionView } from '@podium/client-core/session-values'
import { measureHeader } from '@podium/client-core/perf'
import type { MachineId} from '@podium/model/browser'
import { isMachineOfflineForLiveTerminal, normalizeOriginUrl } from '@podium/model/browser'
import { _isComputingDerivation, compareStructural, computed, onBecomeUnobserved, type IComputedValue } from 'mobx'
import { debugName } from './debug-name'
import type { MobxPool } from './pool'
import { headerIds } from './enumerate'
import type { HeaderEntity, HeaderRows } from './header-schema'
import { LOADING } from './worklist/rollup'
import type { SliceIssue, SliceSession } from './shared/slice-types'
import { isSessionWorking } from './worklist/rollup'
import { headerHostSession, type HeaderAggregate } from './header-session'
import { HeaderSessions } from './header-sessions'
export { EMPTY_HOST_AGGREGATE, type HeaderAggregate } from './header-session'
const sessionPresentOnTask = (session: SessionView) => !session.archived && session.status !== 'exited'
const NO_PROGRESS = { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
const contains = (cwd: string, root: string) => cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)

/** Views over one pool. Memos exist only while observed, and are released when
 * the last subscriber leaves. No raw row mirror, second clock, or peek read. */
export function createHeaderViews(pool: MobxPool) {
  const cache = new Map<string, IComputedValue<unknown>>()
  let sessions: HeaderSessions | undefined
  function sessionIndex() {
    return sessions ??= new HeaderSessions(pool)
  }
  function memo<T>(key: string, read: () => T): T {
    if (!_isComputingDerivation()) return measureHeader(`pool.${key.split(':')[0]}`, read)
    let value = cache.get(key)
    if (!value) {
      value = computed(() => measureHeader(`pool.${key.split(':')[0]}`, read), { equals: compareStructural, name: debugName(() => `header.${key}`) })
      cache.set(key, value)
      onBecomeUnobserved(value, () => cache.delete(key))
    }
    return value.get() as T
  }
  function row<E extends HeaderEntity>(entity: E, id: string): HeaderRows[E] | undefined {
    return pool.row(entity, id) as HeaderRows[E] | undefined
  }
  function issue(id: string): SliceIssue | typeof LOADING | undefined {
    return pool.row('issue', id) as SliceIssue | typeof LOADING | undefined
  }
  function issueSummary(id: string): (Partial<SliceIssue> & { machineId?: MachineId }) | undefined {
    const value = pool.row('issue', id, 'summary')
    return value === LOADING ? undefined : value as (Partial<SliceIssue> & { machineId?: MachineId }) | undefined
  }
  function sessionSummary(id: string): (Partial<SliceSession> & { machineId?: MachineId }) | undefined {
    const model = pool.model('session', id)
    if (model) return model.headerDock
    const value = pool.row('session', id, 'summary')
    return value === LOADING ? undefined : value as (Partial<SliceSession> & { machineId?: MachineId }) | undefined
  }
  function selectedIssue() {
    return memo('selectedIssue', () => {
      const id = pool.selection.keys().next().value
      if (!id) return undefined
      const value = issue(id)
      if (value === LOADING) return LOADING
      if (!value || value.deletedAt) return undefined
      const model = pool.model('issue', id)
      return { ...value, displayRef: model?.displayRef ?? `#${value.seq}` }
    })
  }
  function workingRoster() {
    return memo('workingRoster', () => sessionIndex().working())
  }
  function aggregate(machineId: MachineId | undefined): HeaderAggregate {
    return memo(`aggregate:${machineId ?? ''}`, () => sessionIndex().aggregate(machineId))
  }
  function occupancyKey(): string {
    return memo('occupancy', () => pool.queries.ids({ kind: 'headerOccupancy' }).flatMap((id) => {
      if (pool.tables.session.has(id)) {
        const member = pool.model('session', id)?.headerHost
        return member ? [member.cwd] : []
      }
      const summary = pool.row('session', id, 'summary') as SessionView | typeof LOADING | undefined
      const member = summary && summary !== LOADING && ['live', 'starting', 'reconnecting'].includes(summary.status)
        ? memo(`coldHost:${id}`, () => {
          const value = pool.row('session', id, 'summary') as SessionView | typeof LOADING | undefined
          return headerHostSession(value === LOADING ? undefined : value)
        }) : null
      return member ? [member.cwd] : []
    }).sort().join('\n'))
  }
  function folded() {
    return memo('folded', () => {
      let root = selectedIssue()
      if (root === LOADING) return { root: undefined, progress: NO_PROGRESS, live: 0, working: 0, needs: 0, loading: true }
      const seen = new Set<string>()
      while (root?.parentId && !seen.has(root.id)) {
        seen.add(root.id)
        const parent = issue(root.parentId)
        if (parent === LOADING) return { root: undefined, progress: NO_PROGRESS, live: 0, working: 0, needs: 0, loading: true }
        if (!parent || parent.archived || parent.deletedAt) break
        root = { ...parent, displayRef: pool.model('issue', parent.id)?.displayRef ?? `#${parent.seq}` }
      }
      if (!root || root.archived || root.deletedAt) return { root: undefined, progress: NO_PROGRESS, live: 0, working: 0, needs: 0, loading: false }
      const ids = new Set<string>(), sessions = new Map<string, SliceSession>()
      let loading = false, needs = 0
      // The formal closure is taken once. Provenance admits individual issues,
      // not their formal children (mission.ts computeMissionIssueIds).
      function formal(id: string): void {
        if (ids.has(id)) return
        ids.add(id)
        for (const child of pool.graph.many('issue', id, 'children')) formal(child)
      }
      formal(root.id)
      const queue = [...ids]
      for (let index = 0; index < queue.length; index++) {
        for (const sid of pool.graph.many('issue', queue[index]!, 'sessions')) {
          for (const child of pool.graph.many('session', sid, 'startedIssues')) {
            if (ids.has(child)) continue
            const spawned = issue(child)
            if (spawned === LOADING) { loading = true; continue }
            if (!spawned || (!['backlog', 'proposed'].includes(spawned.stage) && spawned.deps?.some((dep) => dep.type === 'discovered-from'))) continue
            ids.add(child)
            queue.push(child)
          }
        }
      }
      // Placement can hide a provenance branch behind an archived owner.
      // Keep formal edges when their parent is in the mission; otherwise graft
      // under the starter's owner, falling back to the selected mission root.
      const grafts = new Map<string, string[]>()
      for (const id of ids) {
        if (id === root.id) continue
        const value = issue(id)
        if (value === LOADING) { loading = true; continue }
        if (!value || value.archived || value.deletedAt || (value.parentId && ids.has(value.parentId))) continue
        const owner = value.startedBySession ? sessionSummary(value.startedBySession)?.issueId : undefined
        const parent = owner && ids.has(owner) && owner !== id ? owner : root.id
        const siblings = grafts.get(parent) ?? []
        siblings.push(id)
        grafts.set(parent, siblings)
      }
      const visible = new Set<string>()
      function collect(id: string): void {
        if (visible.has(id)) return
        const value = issue(id)
        if (value === LOADING) { loading = true; return }
        if (!value || value.archived || value.deletedAt) return
        visible.add(id)
        const ownIds = [...pool.graph.many('issue', id, 'sessions')]
        let asking = false, staffed = false
        for (const sid of ownIds) {
          const member = pool.row('session', sid) as SliceSession | typeof LOADING | undefined
          if (member === LOADING) { loading = true; continue }
          if (!member || member.archived || member.headless || member.agentKind === 'shell') continue
          sessions.set(sid, member)
          staffed ||= sessionPresentOnTask(member as SessionView)
          asking ||= member.agentState?.phase === 'needs_user' || member.agentState?.phase === 'errored' || !!member.offer
        }
        const vacated = !staffed && pool.graph.size('issue', id, 'spinOffs') > 0
        if (value.stage !== 'done' && !value.closedReason && (asking || value.needsHuman || (value.stage === 'review' && !vacated))) needs++
        for (const child of pool.graph.many('issue', id, 'children')) collect(child)
        for (const child of grafts.get(id) ?? []) collect(child)
      }
      collect(root.id)
      const crew = [...sessions.values()].filter((member) => sessionPresentOnTask(member as SessionView))
      if (root.isDraftVessel && !root.worktreePath && ![...pool.graph.many('issue', root.id, 'sessions')].some((sid) => {
        const member = pool.row('session', sid) as SliceSession | typeof LOADING | undefined
        return member && member !== LOADING && !member.archived
      })) return { root: undefined, progress: NO_PROGRESS, live: 0, working: 0, needs: 0, loading }
      const sidebar = pool.model('issue', root.id)?.sidebar
      if (sidebar === LOADING) loading = true
      return { root, progress: sidebar && sidebar !== LOADING ? sidebar.progress : NO_PROGRESS,
        live: crew.length, working: crew.filter(isSessionWorking).length, needs, loading }
    })
  }
  function shipping() {
    return memo('shipping', () => {
      const state = row('window', 'window')
      let active: { cwd: string; machineId?: string; issueId?: string } | undefined
      if (state?.paneA) {
        const selected = sessionSummary(state.paneA)
        if (selected?.cwd) active = { cwd: selected.cwd, machineId: selected.machineId, issueId: selected.issueId ?? undefined }
        else {
          const tab = state.fileTabs.find((tab) => tab.id === state.paneA)
          if (tab?.worktreePath) active = { cwd: tab.worktreePath, machineId: tab.scope.kind === 'worktree' ? tab.scope.machineId : undefined, issueId: tab.issueId }
        }
      }
      if (!active) {
        let latest: ReturnType<typeof sessionSummary>
        for (const id of pool.queries.ids({ kind: 'headerRecentSession' })) {
          const member = sessionSummary(id)
          if (member && !member.archived && (!latest || (member.lastActiveAt ?? '') > (latest.lastActiveAt ?? ''))) latest = member
        }
        if (latest?.cwd) active = { cwd: latest.cwd, machineId: latest.machineId, issueId: latest.issueId ?? undefined }
      }
      let repoId: string | null = null, scanned = false
      if (active) {
        for (const repo of scannedRepos()) {
          const lane = repo.lanes.filter((lane) => (!active!.machineId || !lane.machineId || lane.machineId === active!.machineId) && contains(active!.cwd, lane.path))
            .sort((a, b) => b.path.length - a.path.length)[0]
          if (lane) { repoId = repo.repoId ?? lane.repoId ?? null; scanned = true; break }
        }
        if (!scanned && active.issueId) repoId = issueSummary(active.issueId)?.repoId ?? null
        if (!scanned && !active.issueId) {
          let best: Partial<SliceIssue> | undefined
          for (const id of pool.queries.ids({ kind: 'containingIssues', cwd: active.cwd })) {
            const candidate = issueSummary(id)
            if (!candidate?.worktreePath || candidate.archived || candidate.deletedAt || !contains(active.cwd, candidate.worktreePath)) continue
            if (!best || candidate.worktreePath.length > (best.worktreePath?.length ?? 0) || (candidate.worktreePath === best.worktreePath && (candidate.seq ?? 0) < (best.seq ?? 0))) best = candidate
          }
          repoId = best?.repoId ?? null
        }
      }
      const orders = repoId ? pool.header.members('repo', repoId, 'shipOrders').flatMap((id) => { const order = row('shipOrder', id); return order ? [order] : [] }) : []
      return { unfinishedCount: orders.filter((order) => ['needs_you', 'in_progress', 'waiting'].includes(order.humanState)).length,
        decisionCount: orders.filter((order) => order.humanState === 'needs_you').length }
    })
  }
  function scannedRepos() {
    return memo('scannedRepos', () => {
      const scans = headerIds(pool, 'repository').flatMap((id) => { const scan = row('repository', id); return scan ? [scan] : [] })
      const linked = new Set(scans.flatMap((scan) => scan.worktrees.map((lane) => lane.path)))
      const groups = new Map<string, HeaderRows['repository'][]>()
      for (const scan of scans) {
        if (linked.has(scan.path)) continue
        const key = scan.repoId ?? (normalizeOriginUrl(scan.originUrl) || `local:${scan.machineId ?? ''}:${scan.path}`)
        const group = groups.get(key) ?? []; group.push(scan); groups.set(key, group)
      }
      return [...groups.values()].map((group) => ({ repoId: group.find((scan) => scan.repoId !== undefined)?.repoId,
        lanes: group.flatMap((scan) => [scan.path, ...scan.worktrees.map((lane) => lane.path)].map((path) => ({ path, machineId: scan.machineId, repoId: scan.repoId }))) }))
    })
  }
  function reclaimCounts(afterDays: number) {
    return memo(`reclaim:${afterDays}`, () => {
      const metrics = headerIds(pool, 'hostMetric')
      const sole = metrics.length === 1 ? pool.header.one('hostMetric', metrics[0]!, 'machine') : undefined
      const occupied = occupancyKey().split('\n').filter(Boolean)
      const result: Record<string, number> = {}
      if (!metrics.length) return result
      for (const id of pool.queries.ids({ kind: 'reclaimIssues' })) {
        const candidate = issueSummary(id)
        if (!candidate?.worktreePath || candidate.deletedAt || !(candidate.stage === 'done' || candidate.closedReason)) continue
        const closed = Date.parse(candidate.closedAt ?? '')
        if (!Number.isFinite(closed) || !pool.clock.reached(closed + afterDays * 86_400_000)) continue
        if (occupied.some((cwd) => contains(cwd, candidate.worktreePath!))) continue
        const machine = candidate.machineId ?? sole
        if (machine) result[machine] = (result[machine] ?? 0) + 1
      }
      return result
    })
  }
  return {
    row, selectedIssue, aggregate, occupancyKey, folded, shipping, reclaimCounts,
    ids: (entity: HeaderEntity) => headerIds(pool, entity),
    metrics: () => headerIds(pool, 'hostMetric').flatMap((id) => { const metric = row('hostMetric', id); return metric ? [metric] : [] }),
    machines: () => headerIds(pool, 'machine').flatMap((id) => { const machine = row('machine', id); return machine ? [machine] : [] }),
    quotas: () => headerIds(pool, 'quota').flatMap((id) => { const quota = row('quota', id); return quota ? [quota] : [] }),
    offlineMachines: () => memo('offlineMachines', () => {
      const sampled = new Set(headerIds(pool, 'hostMetric').map((id) => pool.header.one('hostMetric', id, 'machine')))
      return headerIds(pool, 'machine').flatMap((id) => {
        const machine = row('machine', id)
        if (!machine || !isMachineOfflineForLiveTerminal(machine) || sampled.has(id) || machine.serviceAssignment?.agentExecution === false || machine.revokedAt || machine.supersededBy) return []
        const seen = Date.parse(machine.lastSeenAt)
        return Number.isFinite(seen) && !pool.clock.passed(seen + 7 * 86_400_000) ? [machine] : []
      })
    }),
    history: () => memo('history', () => {
      const reading = row('history', 'fleet')
      if (!reading) return null
      const working = workingRoster().length
      const buckets = reading.buckets.map((bucket, index) => index === reading.buckets.length - 1 ? { ...bucket, count: Math.max(bucket.count, working) } : bucket)
      return { ...reading, peak: Math.max(reading.peak, working), buckets }
    }),
    connection: () => row('connection', 'server'),
    working: workingRoster,
    session: (id: string) => pool.row('session', id) as SessionView | typeof LOADING | undefined,
    clear: () => { sessions?.dispose(); sessions = undefined; cache.clear() },
  }
}
