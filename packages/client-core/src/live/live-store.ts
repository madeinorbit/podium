/**
 * THE LIVESTORE (ADR 12 D1; POD-5798; detailed design 2.2).
 *
 * One MobX home per signed-in user for CONDITIONS: readings of the present that
 * go stale with time. Connection, ping and clock skew; machine online and
 * load; this account's quota and usage; this device's unsent writes.
 *
 * - Never saved. A fresh runtime starts with every reading unknown, so nothing
 *   from a previous run can be shown as current.
 * - Each new value replaces the old one whole (`@observableRef`, frozen maps).
 * - Unknown until the first reading. A reading that goes stale (the connection
 *   was declared lost) becomes unknown again, keeping `last` for "last seen".
 * - Written only by services: the live feed applies topics and connection
 *   facts at most once per frame, and the outbox service writes its counts.
 *   Screens and models read it; nothing else writes it.
 * - Created with the user's runtime and disposed with it, at sign-out.
 */

import { createDemandAtoms, lazy } from '@podium/mobx-helpers'
import type { HostMetricsWire } from '@podium/model'
import type {
  AccountQuotaPayload,
  AccountUsagePayload,
  MachineConditionPayload,
  ServerFeatureFacts,
} from '@podium/protocol'
import { action, observable, observableRef, runInAction } from 'mobx'
import type { OutboxDeadLetterEntry } from '../outbox'

/** A condition's reading (ADR 7 Amendment 2 D20). */
export type Reading<T> =
  | { readonly known: true; readonly value: T; readonly at: number }
  | { readonly known: false; readonly last?: T; readonly since: number }

export const knownReading = <T>(value: T, at: number): Reading<T> =>
  Object.freeze({ known: true, value, at })

export const unknownReading = <T>(since: number, last?: T): Reading<T> =>
  Object.freeze(last === undefined ? { known: false, since } : { known: false, last, since })

/** The newest value a reading carries: the current one, or the last before it went unknown. */
export const lastValue = <T>(reading: Reading<T> | undefined): T | undefined =>
  reading === undefined ? undefined : reading.known ? reading.value : reading.last

/**
 * - `connecting`: no connection yet in this runtime (the first dial).
 * - `online`: connected and answering.
 * - `degraded`: connected, but pings are slow or late (typing will feel laggy).
 * - `offline`: the connection was declared lost (the hub's health rule, not
 *   every socket blip).
 */
export type ConnectionState = 'connecting' | 'online' | 'degraded' | 'offline'

export interface ConnectionCondition {
  readonly state: ConnectionState
  /** When `state` began (epoch ms): "down for 12 s". */
  readonly since: number
  /** The latest ping round-trip; absent before the first pong and while offline. */
  readonly pingMs?: number
  /** Server clock minus this device's (ms); absent until a pong carried the server's clock. */
  readonly skewMs?: number
  /** The server's build, from the newest `welcome`. */
  readonly serverBuild?: string
  /** What the server's build and config say about its feature flags, from the
   *  newest `welcome` (POD-6677); joined with the instance's experimental
   *  toggles by `resolveFeatureStates`. */
  readonly serverFeatures?: ServerFeatureFacts
}

/** This device's unsent writes, as the outbox service last counted them. */
export interface OutboxCondition {
  readonly pending: number
  /** Parked writes waiting for a person to retry or discard them. */
  readonly deadLetters: readonly OutboxDeadLetterEntry[]
}

export type MachineCondition = MachineConditionPayload

/** What a live reading's topic kind names (the subset the LiveStore holds). */
export type LiveTopicKind =
  | 'machine.condition'
  | 'machine.metrics'
  | 'account.quota'
  | 'account.usage'

export interface LiveStoreOptions {
  readonly now?: () => number
  /**
   * Demand for a machine's metrics: called when a reader starts watching
   * `metricsOf(id)` and when the last one stops. The live feed holds the
   * `machine.metrics` topic only in between, so a daemon samples only while
   * somebody looks (ADR 7 Amendment 2 D21).
   */
  readonly onMetricsDemand?: (machineId: string, watched: boolean) => void
  /**
   * Demand for this account's token usage: a reader started or stopped
   * watching {@link LiveStore.usage}. The live feed holds `account.usage`
   * only in between, so the server harvests transcripts only then.
   */
  readonly onUsageDemand?: (watched: boolean) => void
}

const NOT_BORN_CONNECTION: ConnectionCondition = Object.freeze({ state: 'connecting', since: 0 })
const NOT_BORN_READING: Reading<never> = Object.freeze({ known: false, since: 0 })

const EMPTY_OUTBOX: OutboxCondition = Object.freeze({ pending: 0, deadLetters: Object.freeze([]) })

export class LiveStore {
  // Placeholders until the constructor stamps the runtime's birth time.
  @observableRef accessor connection: ConnectionCondition = NOT_BORN_CONNECTION
  @observableRef accessor quota: Reading<AccountQuotaPayload> = NOT_BORN_READING
  /** Read through {@link usage}, which is what asks for it. */
  @observableRef private accessor usageReading: Reading<AccountUsagePayload> = NOT_BORN_READING
  @observableRef accessor outbox: OutboxCondition = EMPTY_OUTBOX
  /** Machine online and since when, held for every machine for the app's lifetime. */
  readonly machineConditions = observable.map<string, Reading<MachineCondition>>(
    {},
    { deep: false, name: 'LiveStore.machineConditions' },
  )
  /** Host metrics, held only for machines somebody is watching. */
  readonly machineMetrics = observable.map<string, Reading<HostMetricsWire>>(
    {},
    { deep: false, name: 'LiveStore.machineMetrics' },
  )

  private readonly now: () => number
  private readonly metricsDemand
  private readonly usageDemand
  private disposed = false

  constructor(options: LiveStoreOptions = {}) {
    this.now = options.now ?? Date.now
    const born = this.now()
    // The first readings: unknown from the moment the runtime is born.
    runInAction(() => {
      this.connection = Object.freeze({ state: 'connecting', since: born })
      this.quota = unknownReading(born)
      this.usageReading = unknownReading(born)
    })
    this.metricsDemand = createDemandAtoms<string>((id) => `LiveStore.metrics:${id}`, {
      onObserved: (id) => {
        if (!this.disposed) options.onMetricsDemand?.(id, true)
      },
      onUnobserved: (id) => {
        if (!this.disposed) options.onMetricsDemand?.(id, false)
      },
    })
    this.usageDemand = createDemandAtoms<'usage'>(() => 'LiveStore.usage', {
      onObserved: () => {
        if (!this.disposed) options.onUsageDemand?.(true)
      },
      onUnobserved: () => {
        if (!this.disposed) options.onUsageDemand?.(false)
      },
    })
  }

  /** Changes sign-out would lose: unapplied writes and authored work kept for recovery.
   * Applied writes waiting for the replica are already safe on the server. */
  @lazy get unsyncedChangeCount(): number {
    return this.outbox.pending + this.outbox.deadLetters.length
  }

  /** A machine's online reading; unknown until its first. */
  conditionOf(machineId: string): Reading<MachineCondition> | undefined {
    return this.machineConditions.get(machineId)
  }

  /** A machine's online as this device knows it: undefined until its first
   *  reading (the input `isSessionReconnecting` takes, ADR 12 D1). */
  onlineOf(machineId: string): boolean | undefined {
    const reading = this.machineConditions.get(machineId)
    return reading?.known ? reading.value.online : undefined
  }

  /**
   * A machine's host metrics. Reading it inside a reaction or an observer IS
   * the demand: the topic is held while somebody watches, and released when the
   * last watcher goes. An untracked read (a handler) neither holds nor releases.
   */
  metricsOf(machineId: string): Reading<HostMetricsWire> | undefined {
    this.metricsDemand.observe(machineId)
    return this.machineMetrics.get(machineId)
  }

  /**
   * This account's token usage. Like {@link metricsOf}, a tracked read is the
   * demand: `account.usage` is held while a usage reader watches this.
   */
  usage(): Reading<AccountUsagePayload> {
    this.usageDemand.observe('usage')
    return this.usageReading
  }

  /** Whether a reader is watching {@link usage} (the live feed's demand). */
  get usageWatched(): boolean {
    return this.usageDemand.size > 0
  }

  /** The machines somebody is watching the metrics of (the live feed's demand). */
  get watchedMetrics(): readonly string[] {
    return [...this.metricsDemand.keys()]
  }

  /** "Used up until": the latest reset among windows at 100%, per agent of each machine. */
  @lazy get quotaUsedUpUntil(): string | null {
    const quota = lastValue(this.quota)
    if (!quota) return null
    let until: string | null = null
    for (const machine of quota.machines)
      for (const agent of machine.agents)
        for (const window of agent.windows)
          if (
            window.usedPercent >= 100 &&
            window.resetsAt !== '' &&
            (until === null || window.resetsAt > until)
          )
            until = window.resetsAt
    return until
  }

  // ---------------------------------------------------------------------------
  // Writes: services only
  // ---------------------------------------------------------------------------

  /** One topic reading (the live feed, once per frame). Undefined forgets the key. */
  @action applyTopic(kind: LiveTopicKind, id: string, reading: Reading<unknown> | undefined): void {
    if (this.disposed) return
    // An unknown reading without its own last value (a fresh subscribe's
    // `pending`) keeps the one already held, for "last seen".
    const carry = <T>(held: Reading<T> | undefined, next: Reading<T>): Reading<T> =>
      !next.known && next.last === undefined && lastValue(held) !== undefined
        ? unknownReading(next.since, lastValue(held))
        : next
    switch (kind) {
      case 'machine.condition': {
        const held = this.machineConditions.get(id)
        if (reading)
          this.machineConditions.set(id, carry(held, reading as Reading<MachineCondition>))
        else this.machineConditions.delete(id)
        return
      }
      case 'machine.metrics': {
        const held = this.machineMetrics.get(id)
        if (reading) this.machineMetrics.set(id, carry(held, reading as Reading<HostMetricsWire>))
        else this.machineMetrics.delete(id)
        return
      }
      case 'account.quota':
        this.quota = carry(
          this.quota,
          (reading as Reading<AccountQuotaPayload> | undefined) ?? unknownReading(this.now()),
        )
        return
      case 'account.usage':
        this.usageReading = carry(
          this.usageReading,
          (reading as Reading<AccountUsagePayload> | undefined) ?? unknownReading(this.now()),
        )
        return
    }
  }

  @action setConnection(next: ConnectionCondition): void {
    if (this.disposed) return
    this.connection = Object.freeze({ ...next })
  }

  @action setOutbox(next: OutboxCondition): void {
    if (this.disposed) return
    if (next.pending === this.outbox.pending && next.deadLetters === this.outbox.deadLetters) return
    this.outbox = Object.freeze({ pending: next.pending, deadLetters: next.deadLetters })
  }

  /**
   * The connection was declared lost: every reading of the present is unknown
   * from `since`, keeping its last value for "last seen".
   */
  @action markAllUnknown(since: number): void {
    if (this.disposed) return
    const stale = <T>(reading: Reading<T>): Reading<T> =>
      reading.known ? unknownReading(since, reading.value) : reading
    this.quota = stale(this.quota)
    this.usageReading = stale(this.usageReading)
    for (const [id, reading] of this.machineConditions)
      this.machineConditions.set(id, stale(reading))
    for (const [id, reading] of this.machineMetrics) this.machineMetrics.set(id, stale(reading))
  }

  /** Sign-out: forget every reading and stop reporting demand. */
  @action dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.metricsDemand.clear()
    this.usageDemand.clear()
    this.machineConditions.clear()
    this.machineMetrics.clear()
    this.quota = unknownReading(this.now())
    this.usageReading = unknownReading(this.now())
    this.outbox = EMPTY_OUTBOX
  }

  get isDisposed(): boolean {
    return this.disposed
  }
}
