import type { ConnectionHealth } from '@podium/client-core/socket-transport'
import { measureHeader } from '@podium/client-core/perf'
import type { IssueId, MachineId, SessionMeta } from '@podium/model/browser'
import { sessionPresentOnTask } from '@podium/model/browser'
import { compareStructural, computed, onBecomeUnobserved, type IComputedValue } from 'mobx'
import type { MobxPool } from './pool'
import { headerIds, knownIssueIds, knownSessionIds, residentSessionIds } from './header-enumerate'
import type { HeaderEntity, HeaderRows } from './header-schema'
import { LOADING } from './shared/links'
import type { SliceIssue, SliceSession } from './shared/slice-types'
import { isSessionWorking } from './worklist/rollup'

export const EMPTY_HOST_AGGREGATE = {
  count: 0, idleSplit: { idle: 0, parkable: 0, protected: 0 },
  phases: { working: 0, idle: 0, waiting: 0, other: 0 },
}
export type HeaderAggregate = typeof EMPTY_HOST_AGGREGATE
const NO_PROGRESS = { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
const contains = (cwd: string, root: string) => cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)

/** Views over one pool. Memos exist only while observed, and are released when
 * the last subscriber leaves. No raw row mirror, second clock, or peek read. */
export function createHeaderViews(pool: MobxPool) {
  const cache = new Map<string, IComputedValue<unknown>>()
  function memo<T>(key: string, read: () => T): T {
    let value = cache.get(key)
    if (!value) {
      value = computed(() => measureHeader(`pool.${key.split(':')[0]}`, read), { equals: compareStructural, name: `header.${key}` })
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
  function issueSummary(id: string): Partial<SliceIssue> | undefined {
    return (pool.hidden('issue', id) ?? pool.row('issue', id)) as Partial<SliceIssue> | undefined
  }
  function sessionSummary(id: string): Partial<SliceSession> | undefined {
    return (pool.hidden('session', id) ?? pool.row('session', id)) as Partial<SliceSession> | undefined
  }
  function selectedIssue() {
    return memo('selectedIssue', () => {
      const id = pool.selection.keys().next().value
      if (!id) return undefined
      const value = issue(id)
      if (value === LOADING || !value || value.deletedAt) return undefined
      const model = pool.model('issue', id)
      return { ...value, displayRef: model?.displayRef ?? `#${value.seq}` }
    })
  }
  function aggregate(machineId: MachineId | undefined): HeaderAggregate {
    return memo(`aggregate:${machineId ?? ''}`, () => {
      const result: HeaderAggregate = structuredClone(EMPTY_HOST_AGGREGATE)
      if (!machineId) return result
      for (const id of pool.header.members('machine', machineId, 'sessions')) {
        const member = pool.model('session', id)?.headerHost
        if (!member || member.archived) continue
        result.count++
        const phase = member.phase
        if (phase === 'working' || phase === 'compacting') result.phases.working++
        else if (phase === 'idle' || phase === 'ended') result.phases.idle++
        else if (phase === 'needs_user') result.phases.waiting++
        else result.phases.other++
        if (member.status !== 'live' || !['idle', 'ended', 'needs_user'].includes(phase ?? '')) continue
        result.idleSplit.idle++
        if (phase === 'needs_user' || !member.resumable) result.idleSplit.protected++
        else result.idleSplit.parkable++
      }
      return result
    })
  }
  function occupancyKey(): string {
    return memo('occupancy', () => residentSessionIds(pool).flatMap((id) => {
      const member = pool.model('session', id)?.headerHost
      return member ? [member.cwd] : []
    }).sort().join('\n'))
  }
  function folded() {
    return memo('folded', () => {
      let root = selectedIssue()
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
      function visit(id: string): void {
        if (ids.has(id)) return
        ids.add(id)
        const value = issue(id)
        if (value === LOADING) { loading = true; return }
        if (!value || value.archived || value.deletedAt) return
        const ownIds = new Set(pool.graph.many('issue', id, 'sessions'))
        if (value.worktreePath) {
          for (const sid of pool.graph.many('worktree', value.worktreePath, 'sessions')) {
            const member = pool.row('session', sid) as SliceSession | typeof LOADING | undefined
            if (member === LOADING) loading = true
            else if (member && !member.issueId) ownIds.add(sid)
          }
        }
        let asking = false
        for (const sid of ownIds) {
          const member = pool.row('session', sid) as SliceSession | typeof LOADING | undefined
          if (member === LOADING) { loading = true; continue }
          if (!member || member.archived) continue
          sessions.set(sid, member)
          asking ||= sessionPresentOnTask(member as SessionMeta) && (member.agentState?.phase === 'needs_user' || member.agentState?.phase === 'errored' || !!member.offer)
          for (const child of pool.graph.many('session', sid, 'startedIssues')) visit(child)
        }
        if (value.stage !== 'done' && !value.closedReason && (asking || value.humanQuestion || value.needsHuman || value.stage === 'review')) needs++
        for (const child of pool.graph.many('issue', id, 'children')) visit(child)
      }
      visit(root.id)
      const crew = [...sessions.values()].filter((member) => sessionPresentOnTask(member as SessionMeta))
      if (root.draft && !root.worktreePath && crew.length === 0) return { root: undefined, progress: NO_PROGRESS, live: 0, working: 0, needs: 0, loading }
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
        let latest: Partial<SliceSession> | undefined
        for (const id of knownSessionIds(pool)) {
          const member = sessionSummary(id)
          if (member && !member.archived && (!latest || (member.lastActiveAt ?? '') > (latest.lastActiveAt ?? ''))) latest = member
        }
        if (latest?.cwd) active = { cwd: latest.cwd, machineId: latest.machineId, issueId: latest.issueId ?? undefined }
      }
      let repoId: string | null = null
      if (active) {
        const lane = pool.graph.one('session', state?.paneA ?? '', 'worktree')
        if (lane) repoId = (pool.row('worktree', lane) as { repoId?: string } | undefined)?.repoId ?? null
        if (!repoId && active.issueId) repoId = issueSummary(active.issueId)?.repoId ?? null
        if (!repoId) {
          let best: Partial<SliceIssue> | undefined
          for (const id of knownIssueIds(pool)) {
            const candidate = issueSummary(id)
            if (!candidate?.worktreePath || candidate.archived || candidate.deletedAt || !contains(active.cwd, candidate.worktreePath)) continue
            if (!best || candidate.worktreePath.length > (best.worktreePath?.length ?? 0) || (candidate.worktreePath === best.worktreePath && (candidate.seq ?? 0) < (best.seq ?? 0))) best = candidate
          }
          repoId = best?.repoId ?? null
        }
      }
      const orders = state?.shipOrders.filter((order) => order.repoId === repoId) ?? []
      return { unfinishedCount: orders.filter((order) => ['needs_you', 'in_progress', 'waiting'].includes(order.humanState)).length,
        decisionCount: orders.filter((order) => order.humanState === 'needs_you').length }
    })
  }
  function reclaimCounts(afterDays: number) {
    return memo(`reclaim:${afterDays}`, () => {
      const metrics = headerIds(pool, 'hostMetric').map((id) => row('hostMetric', id))
      const sole = metrics.length === 1 ? metrics[0]?.machineId : undefined
      const occupied = occupancyKey().split('\n').filter(Boolean)
      const result: Record<string, number> = {}
      if (!metrics.length) return result
      for (const id of knownIssueIds(pool)) {
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
    connection: () => row('connection', 'server'),
    working: () => memo('workingRoster', () => residentSessionIds(pool).flatMap((id) => {
      const member = pool.model('session', id)?.headerWorking
      return member ? [member] : []
    })),
    session: (id: string) => pool.row('session', id) as SessionMeta | typeof LOADING | undefined,
    clear: () => cache.clear(),
  }
}
