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
 *   The socket hub decides that, once, for every held topic (POD-6945); the
 *   reading follows its topic, so this store never marks readings itself.
 * - Written only by services: the live feed applies topics and connection
 *   facts at most once per frame, and the outbox service writes its counts.
 *   Screens and models read it; nothing else writes it.
 * - Created with the user's runtime and disposed with it, at sign-out.
 */

import { createDemandAtoms, lazy } from '@podium/mobx-helpers'
import {
  type HostMetricsWire,
  type LiveTopicOf,
  type LiveValueOf,
  livePartsOf,
  RECORDS,
  type RecordDeclaration,
  type RecordLiveTopicKind,
  type RecordLiveTopicOf,
} from '@podium/model'
import type {
  AccountQuotaPayload,
  AccountUsagePayload,
  MachineConditionPayload,
  ServerFeatureFacts,
  SessionConditionPayload,
  SessionTerminalStatePayload,
} from '@podium/protocol'
import { action, type ObservableMap, observable, observableRef, runInAction } from 'mobx'
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
/** Busy, gated requests, last input time and context use of one session. */
export type SessionCondition = SessionConditionPayload
/** Who controls one session's terminal, its size and its exit. */
export type SessionTerminalState = SessionTerminalStatePayload
/** The session topics the store holds, each only while a reader watches it. */
export type SessionLiveTopicKind = RecordLiveTopicOf<'session'>

/** What a live reading's topic kind names (the subset the LiveStore holds). */
export type LiveTopicKind = RecordLiveTopicKind | 'account.quota' | 'account.usage'

export interface LiveStoreOptions {
  readonly now?: () => number
  /** First/last watcher of any declared record live part. An imperative read adds no demand. */
  readonly onRecordDemand?: (kind: RecordLiveTopicKind, id: string, watched: boolean) => void
  /** Demand for this account's usage remains separate: it belongs to no record. */
  readonly onUsageDemand?: (watched: boolean) => void
}

/** Keep a previous value when a fresh subscribe's pending reading carries none. */
const carry = <T>(held: Reading<T> | undefined, next: Reading<T>): Reading<T> =>
  !next.known && next.last === undefined && lastValue(held) !== undefined
    ? unknownReading(next.since, lastValue(held))
    : next

/**
 * One map and one demand atom family per declared live part. Adding a part or
 * a payload field changes only the declaration, never this storage machinery.
 * No value here enters the durable replica.
 */
export class RecordLiveStore<const R extends readonly RecordDeclaration[]> {
  private readonly parts = new Map<
    string,
    {
      readonly readings: ObservableMap<string, Reading<unknown>>
      readonly demand: ReturnType<typeof createDemandAtoms<string>>
    }
  >()
  protected disposed = false

  constructor(records: R, onDemand?: (kind: LiveTopicOf<R>, id: string, watched: boolean) => void) {
    for (const { topic } of livePartsOf(records)) {
      this.parts.set(topic, {
        readings: observable.map<string, Reading<unknown>>(
          {},
          { deep: false, name: `LiveStore.${topic}` },
        ),
        demand: createDemandAtoms<string>((id) => `LiveStore.${topic}:${id}`, {
          onObserved: (id) => {
            if (!this.disposed) onDemand?.(topic, id, true)
          },
          onUnobserved: (id) => {
            if (!this.disposed) onDemand?.(topic, id, false)
          },
        }),
      })
    }
  }

  /** The map itself adds no demand; lifetime holders and indexes may inspect it. */
  readingsOf<K extends LiveTopicOf<R>>(kind: K): ObservableMap<string, Reading<LiveValueOf<R, K>>> {
    const part = this.parts.get(kind)
    if (!part) throw new Error(`undeclared live topic ${kind}`)
    return part.readings as ObservableMap<string, Reading<LiveValueOf<R, K>>>
  }

  /** A tracked read holds this topic until the last watcher leaves. */
  recordReading<K extends LiveTopicOf<R>>(
    kind: K,
    id: string,
  ): Reading<LiveValueOf<R, K>> | undefined {
    if (this.disposed) return undefined
    this.parts.get(kind)?.demand.observe(id)
    return this.readingsOf(kind).get(id)
  }

  watchedRecords(): ReadonlyArray<{ readonly kind: LiveTopicOf<R>; readonly id: string }> {
    return [...this.parts].flatMap(([kind, part]) =>
      [...part.demand.keys()].map((id) => ({ kind: kind as LiveTopicOf<R>, id })),
    )
  }

  watchedIds(kind: LiveTopicOf<R>): readonly string[] {
    return [...(this.parts.get(kind)?.demand.keys() ?? [])]
  }

  /** The feed's generic dispatch. Unknown kinds belong to non-record readings. */
  @action protected applyRecordTopic(
    kind: string,
    id: string,
    reading: Reading<unknown> | undefined,
  ): boolean {
    const part = this.parts.get(kind)
    if (!part) return false
    if (!this.disposed) {
      if (reading) part.readings.set(id, carry(part.readings.get(id), reading))
      else part.readings.delete(id)
    }
    return true
  }

  @action applyTopic<K extends LiveTopicOf<R>>(
    kind: K,
    id: string,
    reading: Reading<LiveValueOf<R, K>> | undefined,
  ): void {
    this.applyRecordTopic(kind, id, reading)
  }

  /** Sign-out: clear demand without reporting releases to a service already stopped. */
  @action dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const part of this.parts.values()) {
      part.demand.clear()
      part.readings.clear()
    }
  }

  get isDisposed(): boolean {
    return this.disposed
  }
}

const NOT_BORN_CONNECTION: ConnectionCondition = Object.freeze({ state: 'connecting', since: 0 })
const NOT_BORN_READING: Reading<never> = Object.freeze({ known: false, since: 0 })

const EMPTY_OUTBOX: OutboxCondition = Object.freeze({ pending: 0, deadLetters: Object.freeze([]) })

export class LiveStore extends RecordLiveStore<typeof RECORDS> {
  // Placeholders until the constructor stamps the runtime's birth time.
  @observableRef accessor connection: ConnectionCondition = NOT_BORN_CONNECTION
  @observableRef accessor quota: Reading<AccountQuotaPayload> = NOT_BORN_READING
  /** Read through {@link usage}, which is what asks for it. */
  @observableRef private accessor usageReading: Reading<AccountUsagePayload> = NOT_BORN_READING
  @observableRef accessor outbox: OutboxCondition = EMPTY_OUTBOX
  // Named model-facing readers share the declared maps; these allocate no storage.
  get machineConditions() {
    return this.readingsOf('machine.condition')
  }
  get machineMetrics() {
    return this.readingsOf('machine.metrics')
  }
  get sessionConditions() {
    return this.readingsOf('session.condition')
  }
  get sessionTerminalStates() {
    return this.readingsOf('session.terminalState')
  }

  private readonly now: () => number
  private readonly usageDemand

  constructor(options: LiveStoreOptions = {}) {
    super(RECORDS, options.onRecordDemand)
    this.now = options.now ?? Date.now
    const born = this.now()
    // The first readings: unknown from the moment the runtime is born.
    runInAction(() => {
      this.connection = Object.freeze({ state: 'connecting', since: born })
      this.quota = unknownReading(born)
      this.usageReading = unknownReading(born)
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
    return this.recordReading('machine.metrics', machineId)
  }

  /**
   * One session's condition: busy, gated requests, last input time, context
   * use (POD-6764). Like {@link metricsOf}, a tracked read is the demand: the
   * `session.condition` topic is held while somebody watches this session.
   * Unknown until its first reading; the server answers a session nothing runs
   * from its stored row.
   */
  sessionConditionOf(sessionId: string): Reading<SessionCondition> | undefined {
    return this.recordReading('session.condition', sessionId)
  }

  /**
   * One session's terminal state: who controls it, its size, its exit. Held
   * while somebody watches. The size is also stored on the server, so it is
   * known while the session's daemon is offline.
   */
  sessionTerminalStateOf(sessionId: string): Reading<SessionTerminalState> | undefined {
    return this.recordReading('session.terminalState', sessionId)
  }

  /** The sessions somebody is watching a live reading of (the live feed's demand). */
  watchedSessions(kind: SessionLiveTopicKind): readonly string[] {
    return this.watchedIds(kind)
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
    return this.watchedIds('machine.metrics')
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
  @action override applyTopic(
    kind: LiveTopicKind,
    id: string,
    reading: Reading<unknown> | undefined,
  ): void {
    if (this.disposed) return
    if (this.applyRecordTopic(kind, id, reading)) return
    switch (kind) {
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

  /** Sign-out: forget every reading and stop reporting demand. */
  @action override dispose(): void {
    if (this.disposed) return
    super.dispose()
    this.usageDemand.clear()
    this.quota = unknownReading(this.now())
    this.usageReading = unknownReading(this.now())
    this.outbox = EMPTY_OUTBOX
  }
}
