import { modelShares, projectCostShares, usageSummary } from '@podium/client-core/values'
import { lazy } from '@podium/mobx-helpers'
import type { MachineQuotaWire, TaskCostRowWire, UsageBucketWire } from '@podium/model'
import { action, observable, runInAction } from 'mobx'
import type { MobxPool } from './pool'
import { RequestAnswer } from './request-answer'
import { TaskCostView } from './task-cost-view'

interface PulseReading {
  buckets: UsageBucketWire[]
  nowMs: number
}

/** One Pulse opening, with independent usage, quota and task-cost answers.
 * Usage commits the harvest before cost.tasks reads it. A failed reading keeps
 * its previous answer without hiding healthy readings. Concurrent refreshes join. */
export class PulseView extends RequestAnswer<PulseReading> {
  readonly costs: TaskCostView
  readonly quota = new RequestAnswer<MachineQuotaWire[]>()
  // The denominator belongs to the accepted cost harvest, not the latest usage poll.
  @observable private accessor costWindowTotalUsd: number | null = null
  // Stored on open: the loading calendar stays still until a harvest replaces it.
  private readonly openedAt = Date.now()
  private pendingUsage: Promise<void> | undefined
  private pendingQuota: Promise<void> | undefined
  private generation = 0

  constructor(pool: MobxPool) {
    super()
    this.costs = new TaskCostView(pool)
  }

  @action refresh(
    usage: () => Promise<{ buckets: UsageBucketWire[] }>,
    costs: () => Promise<readonly TaskCostRowWire[]>,
    quota?: () => Promise<MachineQuotaWire[]>,
  ): Promise<void> {
    const usageAndCosts = this.refreshUsage(usage, costs)
    return quota
      ? Promise.all([usageAndCosts, this.refreshQuota(quota)]).then(() => undefined)
      : usageAndCosts
  }

  @action refreshQuota(read: () => Promise<MachineQuotaWire[]>): Promise<void> {
    if (this.pendingQuota) return this.pendingQuota
    const pending = this.quota.load(read)
    this.pendingQuota = pending
    void pending.finally(() => {
      if (this.pendingQuota === pending) this.pendingQuota = undefined
    })
    return pending
  }

  @action refreshUsage(
    usage: () => Promise<{ buckets: UsageBucketWire[] }>,
    costs: () => Promise<readonly TaskCostRowWire[]>,
  ): Promise<void> {
    if (this.pendingUsage) return this.pendingUsage
    const generation = this.generation
    let reading: PulseReading | undefined
    const usageAndCosts = this.load(async () => {
      const result = await usage()
      reading = { buckets: result.buckets, nowMs: Date.now() }
      return reading
    }).then(async () => {
      // A blur during usage must not start the next network read. A failed
      // harvest cannot supply a denominator for a new task-cost answer either.
      if (generation !== this.generation) return
      if (!reading) {
        runInAction(() => {
          this.costs.error = this.error
        })
        return
      }
      const total = this.summary.week.estCostUsd
      await this.costs.load(costs, false, (tasks) => {
        this.costWindowTotalUsd = total
        return tasks
      })
    })
    this.pendingUsage = usageAndCosts
    void usageAndCosts.finally(() => {
      if (this.pendingUsage === usageAndCosts) this.pendingUsage = undefined
    })
    return usageAndCosts
  }

  @lazy get summary() {
    return usageSummary(this.answer?.buckets ?? [], this.answer?.nowMs ?? this.openedAt)
  }

  @lazy get models() {
    return modelShares(this.summary, 6)
  }

  @lazy get projects() {
    return this.costWindowTotalUsd !== null && this.costs.projectGroups
      ? projectCostShares(this.costs.projectGroups, this.costWindowTotalUsd)
      : null
  }

  @action override cancel(): void {
    ++this.generation
    super.cancel()
    this.costs.cancel()
    this.quota.cancel()
    this.pendingUsage = undefined
    this.pendingQuota = undefined
  }

  dispose(): void {
    this.close()
    this.costs.dispose()
    this.quota.close()
  }
}

export function createPulseView(pool: MobxPool): PulseView {
  return new PulseView(pool)
}
