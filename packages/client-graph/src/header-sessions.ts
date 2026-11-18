import { here } from './lookup'
import { headerModel } from './header-companion'
import { headerEntities } from './header-entities'
import type { MachineId } from '@podium/model/browser'
import { compareShallow, compareStructural, computed } from 'mobx'
import { cachedKey } from './cached'
import {
  EMPTY_HOST_AGGREGATE,
  type HeaderAggregate,
  headerHostSession,
  type WorkingSession,
} from './header-session'
import type { MobxPool } from './pool'

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

/** Contributions are keyed computeds over the declared machine relation,
 * over the sessions the pool holds (every session on the device, POD-7094). */
export class HeaderSessions {
  private readonly residentHost = cachedKey('pool.header', 'sessionHost', (id) => {
    const model = here(this.pool.row('session', id, 'mark')) === undefined ? undefined : this.pool.sessionObject(id)
    return contribution(model ? headerModel(this.pool).session(model).headerHost : null)
  }, compareStructural)
  private readonly residentWorking = cachedKey('pool.header', 'sessionWorking', (id) => {
    const model = here(this.pool.row('session', id, 'mark')) === undefined ? undefined : this.pool.sessionObject(id)
    return model ? headerModel(this.pool).session(model).working : false
  }, Object.is)
  private readonly machine = cachedKey('pool.header', 'machineAggregate', (id) => {
    const aggregate = structuredClone(EMPTY_HOST_AGGREGATE)
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
    return ids.sort()
  }, { equals: compareShallow })
  private readonly roster = computed(() => this.ids.get().map(id =>
    headerModel(this.pool).session(this.pool.sessionObject(id)).headerWorkingFields),
    { equals: compareShallow })
  private readonly count = computed(() => {
    let count = 0
    for (const id of headerEntities(this.pool).sessionOrder.get()) if (this.residentWorking(id)) count++
    return count
  })

  constructor(private readonly pool: MobxPool) {}

  working(): WorkingSession[] { return this.roster.get() }
  workingIds(): readonly string[] { return this.ids.get() }
  workingCount(): number { return this.count.get() }
  aggregate(machineId: MachineId | undefined): HeaderAggregate {
    return machineId ? this.machine(machineId) : EMPTY_HOST_AGGREGATE
  }

  dispose(): void {}
}
