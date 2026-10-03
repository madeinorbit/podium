import type { SessionView } from '@podium/client-core/session-values'
import type { MachineId } from '@podium/model/browser'
import { compareStructural, observable, observe, reaction, runInAction, untracked } from 'mobx'
import { seedHeaderSessions } from './enumerate'
import {
  EMPTY_HOST_AGGREGATE, headerHostSession, headerWorkingSession,
  type HeaderAggregate, type WorkingSession,
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
    phase: phase === 'working' || phase === 'compacting' ? 'working'
      : phase === 'idle' || phase === 'ended' ? 'idle'
      : phase === 'needs_user' ? 'waiting' : 'other',
    idle: member.status !== 'live' || !['idle', 'ended', 'needs_user'].includes(phase ?? '') ? null
      : phase === 'needs_user' || !member.resumable ? 'protected' : 'parkable',
  }
}

/** Resident models subscribe only to their own row. Unloaded sessions supply
 * declared summaries on registry deltas, without loading or building models.
 * Stored values are header contributions, never session payloads. */
export class HeaderSessions {
  private readonly roster = observable.map<string, WorkingSession>(undefined, { deep: false })
  private readonly aggregates = observable.map<MachineId, HeaderAggregate>(undefined, { deep: false })
  private readonly contributions = new Map<string, Contribution>()
  private readonly residents = new Map<string, () => void>()
  private readonly coldDeadlines = new Map<string, () => void>()
  private readonly stops: (() => void)[]

  constructor(private readonly pool: MobxPool) {
    this.stops = [observe(pool.tables.session, (change) => {
      if (change.type === 'add') this.track(change.name)
      if (change.type === 'delete') this.untrack(change.name)
    })]
    const stopCold = pool.residency?.onColdChange((entity, id) => {
      if (entity === 'session') this.cold(id)
    })
    if (stopCold) this.stops.push(stopCold)
    // Attachment is the only census, and must not become a read dependency.
    untracked(() => seedHeaderSessions(pool, id => this.track(id), id => this.cold(id)))
  }

  private track(id: string): void {
    if (this.residents.has(id)) return
    const read = () => {
      const model = this.pool.model('session', id)
      return { working: model?.headerWorking ?? null, host: contribution(model?.headerHost ?? null) }
    }
    // Seed synchronously even when first attached inside a derivation/action.
    // The reaction then owns overlay, phase and activity-deadline changes.
    const initial = untracked(read)
    this.file(id, initial.working, initial.host)
    this.residents.set(id, reaction(read, value => this.file(id, value.working, value.host), { equals: compareStructural }))
  }

  private untrack(id: string): void {
    this.residents.get(id)?.()
    this.residents.delete(id)
    this.file(id, null, null)
  }

  private cold(id: string): void {
    this.coldDeadlines.get(id)?.()
    this.coldDeadlines.delete(id)
    const coldSummary = () => {
      if (untracked(() => this.pool.row('session', id, 'mark')) !== LOADING) return undefined
      const value = this.pool.row('session', id, 'summary') as SessionView | typeof LOADING | undefined
      return value === LOADING ? undefined : value
    }
    const summary = untracked(coldSummary)
    const read = () => {
      const value = coldSummary()
      return value && !value.archived ? headerWorkingSession(value, at => this.pool.clock.passed(at)) : null
    }
    const working = summary?.status === 'live' && !summary.archived ? untracked(read) : null
    this.file(id, working, contribution(headerHostSession(summary)))
    if (summary?.status === 'live' && !summary.archived) {
      // Expired evidence still observes the clock's rewind atom. Idle cold
      // summaries have no deadline and need no persistent subscription.
      if (summary.agentState?.phase === 'working' || summary.agentState?.phase === 'compacting') {
        this.coldDeadlines.set(id, reaction(read, value => this.fileWorking(id, value), { equals: compareStructural }))
      }
    }
  }

  private fileWorking(id: string, value: WorkingSession | null): void {
    runInAction(() => {
      if (!value) this.roster.delete(id)
      else if (!compareStructural(this.roster.get(id), value)) this.roster.set(id, value)
    })
  }

  private file(id: string, working: WorkingSession | null, next: Contribution | null): void {
    runInAction(() => {
      this.fileWorking(id, working)
      const previous = this.contributions.get(id)
      if (compareStructural(previous ?? null, next)) return
      if (previous) this.adjust(previous, -1)
      if (next) {
        this.contributions.set(id, next)
        this.adjust(next, 1)
      } else this.contributions.delete(id)
    })
  }

  private adjust(value: Contribution, delta: 1 | -1): void {
    const aggregate = structuredClone(this.aggregates.get(value.machineId) ?? EMPTY_HOST_AGGREGATE)
    aggregate.count += delta
    aggregate.phases[value.phase] += delta
    if (value.idle) {
      aggregate.idleSplit.idle += delta
      aggregate.idleSplit[value.idle] += delta
    }
    if (aggregate.count) this.aggregates.set(value.machineId, aggregate)
    else this.aggregates.delete(value.machineId)
  }

  working(): WorkingSession[] {
    // Canonical UTF-16 id order, exactly as knownSessionIds; only working
    // output members are enumerated, never the known-session catalog.
    return [...this.roster.keys()].sort().map(id => this.roster.get(id)!)
  }

  aggregate(machineId: MachineId | undefined): HeaderAggregate {
    return (machineId && this.aggregates.get(machineId)) || EMPTY_HOST_AGGREGATE
  }

  dispose(): void {
    for (const stop of this.stops) stop()
    for (const stop of this.residents.values()) stop()
    for (const stop of this.coldDeadlines.values()) stop()
    this.residents.clear()
    this.coldDeadlines.clear()
    this.contributions.clear()
    runInAction(() => { this.roster.clear(); this.aggregates.clear() })
  }
}
