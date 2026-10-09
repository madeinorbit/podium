import { here, omitGone } from './lookup'
import { headerModel } from './header-companion'
import { headerEntities } from './header-entities'
import type { MachineId } from '@podium/model/browser'
import { compareShallow, compareStructural, computed, observable, observe, runInAction, untracked } from 'mobx'
import { cachedKey } from './cached'
import { seedHeaderSessions } from './enumerate'
import {
  EMPTY_HOST_AGGREGATE,
  type HeaderAggregate,
  headerHostSession,
  type WorkingSession,
} from './header-session'
import type { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

type HostSession = ReturnType<typeof headerHostSession>
type Contribution = {
  machineId: MachineId
  phase: keyof HeaderAggregate['phases']
  idle: 'parkable' | 'protected' | null
}

function contribution(member: HostSession): Contribution | null {
  if (!member || member.archived || !member.machineId) return null
  const phase = member.phase
  return {
    machineId: member.machineId,
    phase:
      phase === 'working' || phase === 'compacting'
        ? 'working'
        : phase === 'idle' || phase === 'ended'
          ? 'idle'
          : phase === 'needs_user'
            ? 'waiting'
            : 'other',
    idle:
      member.status !== 'live' || !['idle', 'ended', 'needs_user'].includes(phase ?? '')
        ? null
        : phase === 'needs_user' || !member.resumable
          ? 'protected'
          : 'parkable',
  }
}

function adjust(aggregate: HeaderAggregate, value: Contribution, delta: 1 | -1): void {
  aggregate.count += delta
  aggregate.phases[value.phase] += delta
  if (value.idle) {
    aggregate.idleSplit.idle += delta
    aggregate.idleSplit[value.idle] += delta
  }
}

/** Resident contributions are keyed computeds over the declared machine
 * relation. Cold contributions are filed in the applying feed action; only
 * compact host values and working evidence are retained while demanded. */
export class HeaderSessions {
  private readonly coldHosts = observable.map<MachineId, HeaderAggregate>(undefined, { deep: false })
  private readonly coldContributions = new Map<string, Contribution>()
  private readonly coldWorking = observable.map<string, number>(undefined, { deep: false })
  /** Count evidence by deadline, so a count never enumerates roster values. */
  private readonly coldCounts = observable.map<number, number>(undefined, { deep: false })
  private readonly stops: (() => void)[]

  private readonly residentHost = cachedKey('pool.header', 'sessionHost', (id) => {
    const model = here(this.pool.row('session', id, 'mark')) === undefined ? undefined : this.pool.sessionObject(id)
    return contribution(model ? headerModel(this.pool).session(model).headerHost : null)
  }, compareStructural)
  private readonly residentWorking = cachedKey('pool.header', 'sessionWorking', (id) => {
    const model = here(this.pool.row('session', id, 'mark')) === undefined ? undefined : this.pool.sessionObject(id)
    return model ? headerModel(this.pool).session(model).working : false
  }, Object.is)
  private readonly machine = cachedKey('pool.header', 'machineAggregate', (id) => {
    const aggregate = structuredClone(this.coldHosts.get(id as MachineId) ?? EMPTY_HOST_AGGREGATE)
    for (const sessionId of headerEntities(this.pool).members('machine', id, 'sessions')) {
      const value = this.residentHost(sessionId)
      if (value) adjust(aggregate, value, 1)
    }
    return aggregate
  }, compareStructural)
  private readonly ids = computed(() => {
    const ids: string[] = []
    for (const id of headerEntities(this.pool).sessionOrder.get()) {
      if (this.residentWorking(id)) ids.push(id)
    }
    for (const [id, deadline] of this.coldWorking) {
      if (!this.pool.clock.passed(deadline)) ids.push(id)
    }
    return ids.sort()
  }, { equals: compareShallow })
  private readonly roster = computed(() => this.ids.get().map(id =>
    headerModel(this.pool).session(this.pool.sessionObject(id)).headerWorkingFields),
    { equals: compareShallow })
  private readonly count = computed(() => {
    let count = 0
    for (const id of headerEntities(this.pool).sessionOrder.get()) if (this.residentWorking(id)) count++
    for (const [deadline, members] of this.coldCounts) if (!this.pool.clock.passed(deadline)) count += members
    return count
  })

  constructor(private readonly pool: MobxPool) {
    this.stops = [observe(pool.tables.session, (change) => {
      // Promotion/eviction happens inside the row's applying action.
      if (change.type === 'add' || change.type === 'delete') this.cold(change.name)
    })]
    const stopCold = pool.residency?.onColdChange((entity, id) => {
      if (entity === 'session') this.cold(id)
    })
    if (stopCold) this.stops.push(stopCold)
    this.stops.push(pool.queries.onChange((event) => {
      if (event.type === 'replace') {
        this.clearCold()
        this.seed()
      } else {
        for (const record of event.rows) if (record.kind === 'session') this.cold(record.id)
      }
    }))
    this.seed()
  }

  private seed(): void {
    // untracked-read: header-attachment
    untracked(() => runInAction(() => seedHeaderSessions(this.pool, () => {}, (id) => this.cold(id))))
  }

  private cold(id: string): void {
    // untracked-read: header-cold-seed
    const summary = untracked(() => {
      if (omitGone(this.pool.row('session', id, 'mark')) !== LOADING) return undefined
      const value = omitGone(this.pool.row('session', id, 'summary')) as { archived?: boolean } | typeof LOADING | undefined
      return value === LOADING ? undefined : value
    })
    const session = this.pool.sessionObject(id), header = headerModel(this.pool).session(session)
    const host = contribution(summary ? header.headerHost : null)
    const deadline = !summary || summary.archived ? undefined : session.computingDeadline
    runInAction(() => {
      const previous = this.coldContributions.get(id)
      if (!compareStructural(previous ?? null, host)) {
        const apply = (value: Contribution, delta: 1 | -1) => {
          const aggregate = structuredClone(this.coldHosts.get(value.machineId) ?? EMPTY_HOST_AGGREGATE)
          adjust(aggregate, value, delta)
          if (aggregate.count) this.coldHosts.set(value.machineId, aggregate)
          else this.coldHosts.delete(value.machineId)
        }
        if (previous) apply(previous, -1)
        if (host) { apply(host, 1); this.coldContributions.set(id, host) }
        else this.coldContributions.delete(id)
      }
      const before = this.coldWorking.get(id)
      if (before !== deadline) {
        if (before !== undefined) this.adjustCount(before, -1)
        if (deadline !== undefined) this.adjustCount(deadline, 1)
        if (deadline !== undefined) this.coldWorking.set(id, deadline)
        else this.coldWorking.delete(id)
      }
    })
  }

  private adjustCount(deadline: number, delta: 1 | -1): void {
    const count = (this.coldCounts.get(deadline) ?? 0) + delta
    if (count) this.coldCounts.set(deadline, count)
    else this.coldCounts.delete(deadline)
  }

  working(): WorkingSession[] { return this.roster.get() }
  workingIds(): readonly string[] { return this.ids.get() }
  workingCount(): number { return this.count.get() }
  aggregate(machineId: MachineId | undefined): HeaderAggregate {
    return machineId ? this.machine(machineId) : EMPTY_HOST_AGGREGATE
  }

  private clearCold(): void {
    this.coldContributions.clear()
    runInAction(() => { this.coldHosts.clear(); this.coldWorking.clear(); this.coldCounts.clear() })
  }
  dispose(): void {
    for (const stop of this.stops) stop()
    this.clearCold()
  }
}
