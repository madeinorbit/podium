import { keyedComputed } from '@podium/mobx-helpers'
import { measureHeader } from '@podium/client-core/perf'
import type { SessionView } from '@podium/client-core/session-values'
import { reposToViews } from '@podium/client-core/values'
import type { MachineId } from '@podium/model/browser'
import { compareStructural, createAtom, reaction } from 'mobx'
import { debugName } from './debug-name'
import { headerIds } from './enumerate'
import type { HeaderEntity, HeaderRows } from './header-schema'
import { type HeaderAggregate, headerHostSession } from './header-session'
import { HeaderSessions } from './header-sessions'
import { missions } from './mission'
import type { MobxPool } from './pool'
import { createQueryResult } from './query-result'
import { sessionSeats } from './session-seats'
import { isFinished } from './shared/predicates'
import type { SliceIssue, SliceSession } from './shared/slice-types'
import { isSessionWorking, LOADING } from './worklist/rollup'

export { EMPTY_HOST_AGGREGATE, type HeaderAggregate } from './header-session'

const sessionPresentOnTask = (session: SessionView) =>
  !session.archived && session.status !== 'exited'
const NO_PROGRESS = { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 }
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
const contains = (cwd: string, root: string) =>
  cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)

/** Views over one pool. Memos exist only while observed, and are released when
 * the last subscriber leaves. No raw row mirror, second clock, or peek read. */
export function createHeaderViews(pool: MobxPool) {
  // Header summaries allocate fresh records; compare their values explicitly.
  const cache = keyedComputed(
    (key: string) => debugName(() => `header.${key}`),
    (key: string, read: () => unknown) => measureHeader(`pool.${key.split(':')[0]}`, read),
    { equals: compareStructural },
  )
  let sessions: HeaderSessions | undefined
  let offline: ReturnType<typeof createQueryResult<HeaderRows['machine']>> | undefined
  function offlineMachines(): HeaderRows['machine'][] {
    offline ??= createQueryResult<HeaderRows['machine']>({
      name: 'header.offlineMachines',
      ids: () => pool.header.offlineMachineIds(pool.clock.current),
      has: (id) => pool.header.hasOfflineMachine(id, pool.clock.current),
      read: (id) => row('machine', id),
      order: (id) => pool.header.offlineMachineOrder(id),
      subscribe(changed) {
        const stopSource = pool.header.subscribeOfflineMachines(changed)
        const stopClock = reaction(
          () => {
            const now = pool.clock.current
            const { previous, next } = pool.header.offlineMachineBoundaries(now)
            if (previous !== undefined) pool.clock.passed(previous)
            if (next !== undefined) pool.clock.passed(next)
            return now
          },
          (now, before) => {
            for (const id of pool.header.crossedOfflineMachineIds(before, now)) changed(id)
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
  const sessionDemand = createAtom('pool.header.sessions.demand',
    () => { sessions ??= new HeaderSessions(pool) },
    () => { sessions?.dispose(); sessions = undefined })
  function sessionIndex<T>(read: (index: HeaderSessions) => T): T {
    sessionDemand.reportObserved()
    if (sessions) return read(sessions)
    // An untracked read must not leave the feed subscribed for the pool's life.
    const index = new HeaderSessions(pool)
    try { return read(index) } finally { index.dispose() }
  }
  const memo = <T>(key: string, read: () => T): T => cache(key, read) as T
  function row<E extends HeaderEntity>(entity: E, id: string): HeaderRows[E] | undefined {
    return pool.row(entity, id) as HeaderRows[E] | undefined
  }
  function issue(id: string): SliceIssue | typeof LOADING | undefined {
    return pool.row('issue', id) as SliceIssue | typeof LOADING | undefined
  }
  function issueSummary(id: string): (Partial<SliceIssue> & { machineId?: MachineId }) | undefined {
    const value = pool.row('issue', id, 'summary')
    return value === LOADING
      ? undefined
      : (value as (Partial<SliceIssue> & { machineId?: MachineId }) | undefined)
  }
  function sessionSummary(
    id: string,
  ): (Partial<SliceSession> & { machineId?: MachineId }) | undefined {
    const model = pool.model('session', id)
    if (model) return model.headerDock
    const value = pool.row('session', id, 'summary')
    return value === LOADING
      ? undefined
      : (value as (Partial<SliceSession> & { machineId?: MachineId }) | undefined)
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
    return memo('workingRoster', () => sessionIndex((index) => index.working()))
  }
  function workingCount() {
    return memo('workingCount', () => sessionIndex((index) => index.workingCount()))
  }
  function aggregate(machineId: MachineId | undefined): HeaderAggregate {
    return memo(`aggregate:${machineId ?? ''}`, () => sessionIndex((index) => index.aggregate(machineId)))
  }
  function occupancyKey(): string {
    return memo('occupancy', () =>
      pool.queries
        .ids({ kind: 'headerOccupancy' })
        .flatMap((id) => {
          if (pool.tables.session.has(id)) {
            const member = pool.model('session', id)?.headerHost
            return member ? [member.cwd] : []
          }
          const summary = pool.row('session', id, 'summary') as
            | SessionView
            | typeof LOADING
            | undefined
          const member =
            summary &&
            summary !== LOADING &&
            ['live', 'starting', 'reconnecting'].includes(summary.status)
              ? memo(`coldHost:${id}`, () => {
                  const value = pool.row('session', id, 'summary') as
                    | SessionView
                    | typeof LOADING
                    | undefined
                  return headerHostSession(value === LOADING ? undefined : value)
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
    const root = value && {
      ...value,
      displayRef: pool.model('issue', value.id)?.displayRef ?? `#${value.seq}`,
    }
    if (!root || root.archived || root.deletedAt) return FOLDED_NONE
    const ids = missions(pool).members(root.id)
    if (ids === LOADING) return FOLDED_LOADING
    const seats = sessionSeats(pool)
    const sessions = new Map<string, SliceSession>()
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
        ? sessionSummary(value.startedBySession)?.issueId
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
        const member = pool.row('session', sid) as SliceSession | typeof LOADING | undefined
        if (member === LOADING) {
          loading = true
          continue
        }
        if (!member || member.archived || member.headless || member.agentKind === 'shell') continue
        sessions.set(sid, member)
        staffed ||= sessionPresentOnTask(member as SessionView)
        asking ||=
          member.agentState?.phase === 'needs_user' ||
          member.agentState?.phase === 'errored' ||
          !!member.offer
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
    const crew = [...sessions.values()].filter((member) =>
      sessionPresentOnTask(member as SessionView),
    )
    if (
      root.isDraftVessel &&
      !root.worktreePath &&
      !present(root.id).some((sid) => {
        const member = pool.row('session', sid) as SliceSession | typeof LOADING | undefined
        return member && member !== LOADING && !member.archived
      })
    )
      return { root: undefined, progress: NO_PROGRESS, live: 0, working: 0, needs: 0, loading }
    const sidebar = pool.model('issue', root.id)?.sidebar
    if (sidebar === LOADING) loading = true
    return {
      root,
      progress: sidebar && sidebar !== LOADING ? sidebar.progress : NO_PROGRESS,
      live: crew.length,
      working: crew.filter(isSessionWorking).length,
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
        const scope = pool.header.shippingScope(active.cwd, active.machineId)
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
      return pool.header.shippingCounts(repoId)
    })
  }
  function reclaimCounts(afterDays: number) {
    return memo(`reclaim:${afterDays}`, () => {
      const metrics = headerIds(pool, 'hostMetric')
      const sole =
        metrics.length === 1 ? pool.header.one('hostMetric', metrics[0]!, 'machine') : undefined
      const occupied = occupancyKey().split('\n').filter(Boolean)
      const result: Record<string, number> = {}
      if (!metrics.length) return result
      for (const id of pool.queries.ids({ kind: 'reclaimIssues' })) {
        const candidate = issueSummary(id)
        if (!candidate?.worktreePath || candidate.deletedAt || !isFinished(candidate)) continue
        const closed = Date.parse(candidate.closedAt ?? '')
        if (!Number.isFinite(closed) || !pool.clock.reached(closed + afterDays * 86_400_000))
          continue
        if (occupied.some((cwd) => contains(cwd, candidate.worktreePath!))) continue
        const machine = candidate.machineId ?? sole
        if (machine) result[machine] = (result[machine] ?? 0) + 1
      }
      return result
    })
  }
  return {
    row,
    selectedIssue,
    aggregate,
    occupancyKey,
    folded,
    shipping,
    reclaimCounts,
    repositoryCount: () => pool.header.count('repository'),
    repository: (path: string) =>
      memo(`repository:${path}`, () => {
        const scans = pool.header.repositoryGroup(path).flatMap((id) => {
          const scan = row('repository', id)
          return scan ? [scan] : []
        })
        return reposToViews(scans)[0]
      }),
    idleCapUnmetCount: () => pool.header.idleCapUnmetCount(),
    panelMetric: (machineId: MachineId | undefined) => {
      const id = machineId ?? pool.header.firstId('hostMetric')
      return id ? row('hostMetric', id) : undefined
    },
    ids: (entity: HeaderEntity) => headerIds(pool, entity),
    metrics: () =>
      headerIds(pool, 'hostMetric').flatMap((id) => {
        const metric = row('hostMetric', id)
        return metric ? [metric] : []
      }),
    machines: () =>
      headerIds(pool, 'machine').flatMap((id) => {
        const machine = row('machine', id)
        return machine ? [machine] : []
      }),
    quotas: () =>
      headerIds(pool, 'quota').flatMap((id) => {
        const quota = row('quota', id)
        return quota ? [quota] : []
      }),
    offlineMachines,
    history: () =>
      memo('history', () => {
        const reading = row('history', 'fleet')
        if (!reading) return null
        const working = workingCount()
        const buckets = reading.buckets.map((bucket, index) =>
          index === reading.buckets.length - 1
            ? { ...bucket, count: Math.max(bucket.count, working) }
            : bucket,
        )
        return { ...reading, peak: Math.max(reading.peak, working), buckets }
      }),
    connection: () => row('connection', 'server'),
    working: workingRoster,
    workingCount,
    session: (id: string) => pool.row('session', id) as SessionView | typeof LOADING | undefined,
    clear: () => {
      sessions?.dispose()
      sessions = undefined
      offline?.dispose()
      offline = undefined
      cache.clear()
    },
  }
}

/** The screen registry owns creation and teardown of this view. */
export function headerView(pool: MobxPool) {
  return pool.sources.view('header.views', () => {
    const view = createHeaderViews(pool)
    return Object.assign(view, { dispose: () => view.clear() })
  })
}
