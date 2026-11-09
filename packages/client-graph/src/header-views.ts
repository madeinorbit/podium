import { lastValue } from '@podium/client-core/live'
import type { SessionView } from '@podium/client-core/session-values'
import { reposToViews } from '@podium/client-core/values'
import { keyedComputed } from '@podium/mobx-helpers'
import type { HostMetricsWire, MachineId, MachineQuotaWire } from '@podium/model/browser'
import { machinePathKey } from '@podium/model/browser'
import { compareStructural, computed, createAtom, reaction } from 'mobx'
import { debugName } from './debug-name'
import { headerIds } from './enumerate'
import { headerModel } from './header-companion'
import { headerEntities } from './header-entities'
import { headerRequests } from './header-requests'
import type { HeaderEntity, HeaderRows } from './header-schema'
import type { HeaderAggregate } from './header-session'
import { HeaderSessions } from './header-sessions'
import { instancePreferences } from './instance-preferences'
import { here, omitGone } from './lookup'
import { missions } from './mission'
import type { IssueModel, MachineModel, SessionModel } from './models'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { sessionSeats } from './session-seats'
import { isFinished } from './shared/predicates'
import type { SliceIssue, SliceSession } from './shared/slice-types'
import { isSessionWorking, LOADING } from './worklist/rollup'
import { sidebarIssueProgress } from './worklist/sidebar'

export { EMPTY_HOST_AGGREGATE, type HeaderAggregate } from './header-session'

const EMPTY_QUOTAS: readonly MachineQuotaWire[] = []

const sessionPresentOnTask = (session: SessionView) =>
  !session.archived && session.status !== 'exited'
const NO_PROGRESS = { total: 0, done: 0, working: 0, waiting: 0, todo: 0 }
const FOLDED_LOADING = {
  root: undefined,
  progress: NO_PROGRESS,
  live: 0,
  working: 0,
  needs: 0,
  loading: true,
}
const FOLDED_NONE = {
  root: undefined,
  progress: NO_PROGRESS,
  live: 0,
  working: 0,
  needs: 0,
  loading: false,
}
/** Views over one pool. Memos exist only while observed, and are released when
 * the last subscriber leaves. No raw row mirror, second clock, or peek read. */
function createHeaderViews(pool: MobxPool) {
  // Header summaries allocate fresh records; compare their values explicitly.
  const cache = keyedComputed(
    (key: string) => debugName(() => `header.${key}`),
    (_key: string, read: () => unknown) => read(),
    { equals: compareStructural },
  )
  const machineModel = (id: string) => here(pool.model('machine', id)) as MachineModel | undefined
  let sessions: HeaderSessions | undefined
  let offline: ReturnType<typeof createQueryResult<MachineModel>> | undefined
  function offlineMachines(): MachineModel[] {
    offline ??= createQueryResult<MachineModel>({
      name: 'header.offlineMachines',
      ids: () => headerEntities(pool).offlineMachineIds(pool.clock.peekNow()),
      has: (id) => headerEntities(pool).hasOfflineMachine(id, pool.clock.peekNow()),
      read: (id) => machineModel(id),
      order: (id) => headerEntities(pool).offlineMachineOrder(id),
      subscribe(changed) {
        const stopSource = headerEntities(pool).subscribeOfflineMachines(changed)
        const stopClock = reaction(
          () => {
            const now = pool.clock.peekNow()
            const { previous, next } = headerEntities(pool).offlineMachineBoundaries(now)
            if (previous !== undefined) pool.clock.passed(previous)
            if (next !== undefined) pool.clock.passed(next)
            return now
          },
          (now, before) => {
            for (const id of headerEntities(pool).crossedOfflineMachineIds(before, now)) changed(id)
          },
        )
        return () => {
          stopSource()
          stopClock()
        }
      },
      released: () => {
        offline = undefined
      },
    })
    const value = offline.get()
    return value === LOADING ? [] : (value ?? [])
  }
  const sessionDemand = createAtom(
    'pool.header.sessions.demand',
    () => {
      sessions ??= new HeaderSessions(pool)
    },
    () => {
      sessions?.dispose()
      sessions = undefined
    },
  )
  function sessionIndex<T>(read: (index: HeaderSessions) => T): T {
    sessionDemand.reportObserved()
    if (sessions) return read(sessions)
    // An untracked read must not leave the feed subscribed for the pool's life.
    const index = new HeaderSessions(pool)
    try {
      return read(index)
    } finally {
      index.dispose()
    }
  }
  const memo = <T>(key: string, read: () => T): T => cache(key, read) as T
  // Chrome shows a number. Keep each scan's length behind a scalar computed,
  // then share the total independently of window controls and row metadata.
  const scanWorktreeCount = keyedComputed(
    (id: string) => debugName(() => `header.worktreeCount:${id}`),
    (id: string) => row('repository', id)?.worktrees.length ?? 0,
  )
  const worktreeCount = computed(
    () => headerIds(pool, 'repository').reduce((sum, id) => sum + scanWorktreeCount(id), 0),
    { name: debugName(() => 'header.worktreeCount') },
  )
  function row<E extends HeaderEntity>(entity: E, id: string): HeaderRows[E] | undefined {
    return omitGone(pool.row(entity, id)) as HeaderRows[E] | undefined
  }
  function issue(id: string): SliceIssue | typeof LOADING | undefined {
    return omitGone(pool.row('issue', id)) as SliceIssue | typeof LOADING | undefined
  }
  function issueSummary(id: string): (Partial<SliceIssue> & { machineId?: MachineId }) | undefined {
    const value = omitGone(pool.row('issue', id, 'summary'))
    return value === LOADING
      ? undefined
      : (value as (Partial<SliceIssue> & { machineId?: MachineId }) | undefined)
  }
  function sessionSummary(
    id: string,
  ): (Partial<SliceSession> & { machineId?: MachineId }) | undefined {
    const model =
      here(pool.row('session', id, 'mark')) === undefined ? undefined : pool.sessionObject(id)
    if (model) return headerModel(pool).session(model).headerDock
    const value = omitGone(pool.row('session', id, 'summary'))
    return value === LOADING
      ? undefined
      : (value as (Partial<SliceSession> & { machineId?: MachineId }) | undefined)
  }
  function selectedIssue(): IssueModel | typeof LOADING | undefined {
    return headerModel(pool).selectedIssue
  }
  function workingIds() {
    return sessionIndex((index) => index.workingIds())
  }

  function workingRoster() {
    return sessionIndex((index) => index.working())
  }
  function workingCount() {
    return memo('workingCount', () => sessionIndex((index) => index.workingCount()))
  }
  function aggregate(machineId: MachineId | undefined): HeaderAggregate {
    return memo(`aggregate:${machineId ?? ''}`, () =>
      sessionIndex((index) => index.aggregate(machineId)),
    )
  }
  function occupancyKey(): string {
    return memo('occupancy', () =>
      pool.queries
        .ids({ kind: 'headerOccupancy' })
        .flatMap((id) => {
          if (pool.tables.session.has(id)) {
            const session = here(pool.model('session', id))
            const member = session ? headerModel(pool).session(session).headerHost : null
            return member ? [member.cwd] : []
          }
          const summary = omitGone(pool.row('session', id, 'summary')) as
            | SessionView
            | typeof LOADING
            | undefined
          const member =
            summary && summary !== LOADING && ['live', 'starting'].includes(summary.status)
              ? memo(`coldHost:${id}`, () => {
                  const value = omitGone(pool.row('session', id, 'summary')) as
                    | SessionView
                    | typeof LOADING
                    | undefined
                  return value && value !== LOADING
                    ? headerModel(pool).session(pool.sessionObject(id)).headerHost
                    : null
                })
              : null
          return member ? [member.cwd] : []
        })
        .sort()
        .join('\n'),
    )
  }
  function folded() {
    return memo('folded', () => {
      const selected = selectedIssue()
      if (selected === LOADING) return FOLDED_LOADING
      if (!selected) return FOLDED_NONE
      // The one mission reader answers the root and its members (review
      // findings 4 and 23): no second closure rule, no member-history loads.
      const rootId = missions(pool).rootFor(selected.id)
      if (rootId === LOADING) return FOLDED_LOADING
      if (!rootId) return FOLDED_NONE
      // Another row of the same mission reuses the mission's cached summary.
      return memo(`foldedMission:${rootId}`, () => foldedMission(rootId))
    })
  }
  function foldedMission(rootId: string) {
    const value = issue(rootId)
    if (value === LOADING) return FOLDED_LOADING
    // The same root value selectedIssue() gives when the root is selected.
    const root: IssueModel | undefined = value && here(pool.model('issue', value.id))
    if (!root || root.archived || root.deletedAt) return FOLDED_NONE
    const ids = missions(pool).members(root.id)
    if (ids === LOADING) return FOLDED_LOADING
    const seats = sessionSeats(pool)
    const sessions = new Map<string, SessionModel>()
    let loading = false,
      needs = 0
    // Placement can hide a provenance branch behind an archived owner.
    // Keep formal edges when their parent is in the mission; otherwise graft
    // under the starter's owner, falling back to the selected mission root.
    const grafts = new Map<string, string[]>()
    for (const id of ids) {
      if (id === root.id) continue
      const value = issue(id)
      if (value === LOADING) {
        loading = true
        continue
      }
      if (
        !value ||
        value.archived ||
        value.deletedAt ||
        (value.parentId && ids.has(value.parentId))
      )
        continue
      const owner = value.startedBySession
        ? pool.sessionObject(value.startedBySession).issueLink
        : undefined
      const parent = owner && ids.has(owner) && owner !== id ? owner : root.id
      const siblings = grafts.get(parent) ?? []
      siblings.push(id)
      grafts.set(parent, siblings)
    }
    /** Seated members, and cold ones whose summary does not say: their rows
     * settle the flag below. Known archived history is never read. */
    function present(id: string): readonly string[] {
      const partition = seats.partition('sessions', id)
      if (partition === LOADING) {
        loading = true
        return []
      }
      return partition.unknown.length
        ? [...partition.present, ...partition.unknown]
        : partition.present
    }
    const visible = new Set<string>()
    function collect(id: string): void {
      if (visible.has(id)) return
      const value = issue(id)
      if (value === LOADING) {
        loading = true
        return
      }
      if (!value || value.archived || value.deletedAt) return
      visible.add(id)
      let asking = false,
        staffed = false
      for (const sid of present(id)) {
        const resident = pool.resident('session', sid)
        if (resident === 'loading') {
          loading = true
          continue
        }
        if (resident === 'absent') continue
        const member = pool.sessionObject(sid)
        if (member.archived || member.headless || member.agentKind === 'shell') continue
        sessions.set(sid, member)
        staffed ||= member.open
        asking ||= member.attention
      }
      const vacated = !staffed && pool.graph.size('issue', id, 'spinOffs') > 0
      if (
        !isFinished(value) &&
        (asking || value.needsHuman || (value.stage === 'review' && !vacated))
      )
        needs++
      for (const child of pool.graph.many('issue', id, 'children')) collect(child)
      for (const child of grafts.get(id) ?? []) collect(child)
    }
    collect(root.id)
    const crew = [...sessions.values()].filter((member) => member.open)
    if (
      root.isDraftVessel &&
      !root.worktreePath &&
      !present(root.id).some((sid) => {
        const state = pool.resident('session', sid)
        return state === 'resident' && !pool.sessionObject(sid).archived
      })
    )
      return { root: undefined, progress: NO_PROGRESS, live: 0, working: 0, needs: 0, loading }
    const model = here(pool.model('issue', root.id))
    const progress = model === undefined ? undefined : sidebarIssueProgress(model)
    if (progress === LOADING) loading = true
    return {
      root,
      progress: progress && progress !== LOADING ? progress : NO_PROGRESS,
      live: crew.length,
      working: crew.filter((member) => member.executing).length,
      needs,
      loading,
    }
  }
  function shipping() {
    return memo('shipping', () => {
      const state = row('window', 'window')
      let active: { cwd: string; machineId?: string; issueId?: string } | undefined
      if (state?.paneA) {
        const selected = sessionSummary(state.paneA)
        if (selected?.cwd)
          active = {
            cwd: selected.cwd,
            machineId: selected.machineId,
            issueId: selected.issueId ?? undefined,
          }
        else {
          const tab = state.fileTabs.find((tab) => tab.id === state.paneA)
          if (tab?.worktreePath)
            active = {
              cwd: tab.worktreePath,
              machineId: tab.scope.kind === 'worktree' ? tab.scope.machineId : undefined,
              issueId: tab.issueId,
            }
        }
      }
      if (!active) {
        let latest: ReturnType<typeof sessionSummary>
        let latestId: string | undefined
        const excluded = new Set<string>()
        for (;;) {
          const before = excluded.size
          for (const id of pool.queries.ids({
            kind: 'headerRecentSession',
            excluded: [...excluded],
          })) {
            const member = sessionSummary(id)
            if (!member || member.archived) {
              excluded.add(id)
              continue
            }
            if (
              !latest ||
              (member.lastActiveAt ?? '') > (latest.lastActiveAt ?? '') ||
              ((member.lastActiveAt ?? '') === (latest.lastActiveAt ?? '') && id < latestId!)
            ) {
              latest = member
              latestId = id
            }
          }
          if (excluded.size === before) break
        }
        if (latest?.cwd)
          active = {
            cwd: latest.cwd,
            machineId: latest.machineId,
            issueId: latest.issueId ?? undefined,
          }
      }
      let repoId: string | null = null,
        scanned = false
      if (active) {
        const scope = headerEntities(pool).shippingScope(active.cwd, active.machineId)
        if (scope) {
          repoId = scope.repoId
          scanned = true
        }
        if (!scanned && active.issueId) repoId = issueSummary(active.issueId)?.repoId ?? null
        if (!scanned && !active.issueId) {
          const id = pool.queries.containingIssueId(active.cwd)
          repoId = id ? (issueSummary(id)?.repoId ?? null) : null
        }
      }
      return headerEntities(pool).shippingCounts(repoId)
    })
  }
  /** My fleet: the machines I may see, those with my own access row
   *  (POD-6644). A machine record alone (every member has it) is not one. */
  const fleetIds = (): readonly string[] =>
    memo('fleetIds', () => headerIds(pool, 'machine').filter((id) => headerEntities(pool).inFleet(id)))
  function fleetMetrics(): HostMetricsWire[] {
    return memo('metrics', () =>
      fleetIds().flatMap((id) => {
        const metric = machineModel(id)?.metrics
        return metric ? [metric] : []
      }),
    )
  }
  return {
    row,
    selectedIssue,
    aggregate,
    occupancyKey,
    folded,
    shipping,
    repositoryCount: () => headerEntities(pool).count('repository'),
    worktreeCount: () => worktreeCount.get(),
    repository: (path: string) =>
      memo(`repository:${machinePathKey(path)}`, () => {
        const scans = headerEntities(pool)
          .repositoryGroup(path)
          .flatMap((id) => {
            const scan = row('repository', id)
            return scan ? [scan] : []
          })
        return reposToViews(scans)[0]
      }),
    /** Machines whose host sample reports an unmet idle cap (the live readings). */
    idleCapUnmetCount: () =>
      memo('idleCapUnmet', () =>
        fleetMetrics().reduce((sum, metric) => sum + (metric.idleCapUnmet ?? 0), 0),
      ),
    /** One machine's live sample; with no machine named, the first fleet machine that has one. */
    panelMetric: (machineId: MachineId | undefined) => {
      if (machineId) return machineModel(machineId)?.metrics
      // The first that has one; later machines are neither read nor watched.
      for (const id of fleetIds()) {
        const metric = machineModel(id)?.metrics
        if (metric) return metric
      }
      return undefined
    },
    /** One machine's live sample (the machine model's field). */
    metric: (machineId: string) => machineModel(machineId)?.metrics,
    /** The fleet machines that have a live sample, in fleet order. */
    metricIds: () =>
      memo('metricIds', () => fleetIds().filter((id) => machineModel(id)?.metrics !== undefined)),
    ids: (entity: HeaderEntity) => headerIds(pool, entity),
    /** Live samples of the fleet machines, in fleet order (watching them holds their topics). */
    metrics: fleetMetrics,
    /** My fleet's machine models (records, my access, live condition). */
    machines: (): MachineModel[] =>
      fleetIds().flatMap((id) => {
        const machine = machineModel(id)
        return machine ? [machine] : []
      }),
    /** This account's plan quota per machine: the LiveStore's newest reading in this run. */
    quotas: () => lastValue(pool.live?.quota)?.machines ?? EMPTY_QUOTAS,
    offlineMachines,
    history: () =>
      memo('history', () => {
        const reading = headerRequests(pool)?.history
        if (!reading) return null
        const working = workingCount()
        const buckets = reading.buckets.map((bucket, index) =>
          index === reading.buckets.length - 1
            ? { ...bucket, count: Math.max(bucket.count, working) }
            : bucket,
        )
        return { ...reading, peak: Math.max(reading.peak, working), buckets }
      }),
    /** The connection condition (LiveStore). */
    connection: () => pool.live?.connection,
    /** The host lifecycle settings: the synced instance settings (POD-6677). */
    lifecycle: () => instancePreferences(pool)?.lifecycle ?? null,
    working: workingRoster,
    workingIds,
    workingCount,
    session: (id: string) =>
      omitGone(pool.row('session', id)) as SessionView | typeof LOADING | undefined,
    clear: () => {
      sessions?.dispose()
      sessions = undefined
      offline?.dispose()
      offline = undefined
      scanWorktreeCount.clear()
      cache.clear()
    },
  }
}

/** The screen registry owns creation and teardown of this view. */
export function headerView(
  pool: MobxPool,
): ReturnType<typeof createHeaderViews> & { dispose(): void } {
  return pool.sources.view('header.views', () => {
    const view = createHeaderViews(pool)
    return Object.assign(view, { dispose: () => view.clear() })
  })
}
