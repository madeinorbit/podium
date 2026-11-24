import { lastValue, type Reading } from '@podium/client-core/live'
import { modelShares, projectCostShares, usageSummary } from '@podium/client-core/values'
import { lazy } from '@podium/mobx-helpers'
import type { MachineQuotaWire, TaskCostRowWire, UsageBucketWire } from '@podium/model'
import type { AccountUsagePayload } from '@podium/protocol'
import { action, observable, observableRef, untracked } from 'mobx'
import type { MobxPool } from './pool'
import { TaskCostView } from './task-cost-view'

/**
 * One Pulse opening (POD-2379, POD-2385, POD-2391) on the pushed readings of
 * POD-5798.
 *
 * QUOTA AND USAGE ARE LIVE VALUES. The server pushes this account's quota on
 * `account.quota` (held for the app's life) and its usage on `account.usage`;
 * the LiveStore holds them. Reading {@link buckets} from an observer is what
 * holds `account.usage`, so the server harvests only while Pulse is on screen.
 * When the connection drops the last value stays as "last read", so each
 * reading fails on its own and never hides a healthy one.
 *
 * TASK COSTS STAY A REQUEST (`cost.tasks` is a ranked table, not a condition).
 * The server folds their rows inside the usage harvest, before the usage value
 * is pushed, so the screen asks again whenever {@link usageStamp} moves. The
 * project shares divide by the usage total that request was asked against.
 */
export class PulseView {
  readonly costs: TaskCostView
  @observable private accessor costWindowTotalUsd: number | null = null
  /** The demo build's figures, read in place of the live values. */
  @observableRef private accessor fixture: {
    buckets: UsageBucketWire[]
    quota: MachineQuotaWire[]
    at: number
  } | null = null
  // Stored on open: the loading calendar stays still until a reading replaces it.
  private readonly openedAt = Date.now()
  /** The screen is focused: only then does reading usage hold `account.usage`. */
  @observable private accessor active = true
  /** The usage reading as it stood when the screen lost focus, shown on return
   *  until the topic answers again. */
  @observableRef private accessor heldUsage: Reading<AccountUsagePayload> | undefined = undefined
  /** When each usage value was first received, so a later disconnect cannot
   *  move the clock its figures are derived against. */
  private readonly receivedAt = new WeakMap<object, number>()

  constructor(private readonly pool: MobxPool) {
    this.costs = new TaskCostView(pool)
  }

  private get usageReading(): Reading<AccountUsagePayload> | undefined {
    return this.active ? this.pool.live?.usage() : this.heldUsage
  }

  /**
   * Focus follows the tab. Leaving Pulse stops reading `account.usage`, so the
   * server stops harvesting transcripts for a screen nobody sees; the last
   * reading stays on screen for the return.
   */
  @action setActive(active: boolean): void {
    if (this.active === active) return
    // untracked-read: pulse-held-usage
    if (!active) this.heldUsage = untracked(() => this.pool.live?.usage())
    this.active = active
  }

  private get quotaReading() {
    return this.pool.live?.quota
  }

  /** Null until this run has had a usage value (the one cold state), or when
   *  the server answered without usage. */
  @lazy get buckets(): UsageBucketWire[] | null {
    if (this.fixture) return this.fixture.buckets
    return lastValue(this.usageReading)?.buckets ?? null
  }

  /**
   * The usage reading's own clock, which every figure is derived against: the
   * daemon's scan time when it sent one, else when the value arrived. Both
   * belong to the value, so a dropped connection leaves the figures as they
   * were while the screen says they are the last reading.
   */
  @lazy get usageAt(): number | null {
    if (this.fixture) return this.fixture.at
    const reading = this.usageReading
    const value = lastValue(reading)
    if (!reading || !value) return null
    const sampled = Date.parse(value.sampledAt ?? '')
    if (Number.isFinite(sampled)) return sampled
    if (reading.known && !this.receivedAt.has(value)) this.receivedAt.set(value, reading.at)
    return this.receivedAt.get(value) ?? (reading.known ? reading.at : reading.since)
  }

  /** Moves when a fresh usage value lands: the harvest that folds the task-cost
   *  rows has run. Null while no fresh value is known. */
  @lazy get usageStamp(): number | null {
    const reading = this.usageReading
    return reading?.known && reading.value !== null ? reading.at : null
  }

  /** What is on screen is not current: the connection was lost (the last value
   *  is kept), or the server answered without usage (no machine may read this
   *  account's transcripts, or the scan failed). */
  @lazy get usageFailed(): boolean {
    if (this.fixture) return false
    const reading = this.usageReading
    if (!reading) return false
    const value = lastValue(reading)
    return value === null || (value !== undefined && !reading.known)
  }

  /** Null until this run has had a quota value. */
  @lazy get quota(): MachineQuotaWire[] | null {
    if (this.fixture) return this.fixture.quota
    return lastValue(this.quotaReading)?.machines ?? null
  }

  @lazy get quotaAt(): number | null {
    if (this.fixture) return this.fixture.at
    const reading = this.quotaReading
    if (!reading) return null
    if (reading.known) return reading.at
    return reading.last !== undefined ? reading.since : null
  }

  /** The connection was lost; the quota on screen is the last value. */
  @lazy get quotaFailed(): boolean {
    if (this.fixture) return false
    const reading = this.quotaReading
    return reading !== undefined && !reading.known && reading.last !== undefined
  }

  /** The demo build: fixed figures instead of the live values. */
  @action showFixture(buckets: UsageBucketWire[], quota: MachineQuotaWire[]): void {
    this.fixture = { buckets, quota, at: Date.now() }
  }

  /**
   * Asks for the task-cost rows; of overlapping asks only the newest lands. The
   * rows were folded by the harvest behind the usage on screen when asked, so
   * the project shares divide by that usage total, not by a later push.
   */
  @action refreshCosts(read: () => Promise<readonly TaskCostRowWire[]>): Promise<void> {
    const total = this.summary.week.estCostUsd
    return this.costs.load(read, false, (tasks) => {
      this.costWindowTotalUsd = total
      return tasks
    })
  }

  @lazy get summary() {
    return usageSummary(this.buckets ?? [], this.usageAt ?? this.openedAt)
  }

  @lazy get models() {
    return modelShares(this.summary, 6)
  }

  @lazy get projects() {
    return this.costWindowTotalUsd !== null && this.costs.projectGroups
      ? projectCostShares(this.costs.projectGroups, this.costWindowTotalUsd)
      : null
  }

  @action cancel(): void {
    this.costs.cancel()
  }

  dispose(): void {
    this.costs.dispose()
  }
}

export function createPulseView(pool: MobxPool): PulseView {
  return new PulseView(pool)
}
