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
  private pending: Promise<void> | undefined
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
    if (this.pending) return this.pending
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
    const pending = Promise.all([usageAndCosts, quota ? this.quota.load(quota) : undefined]).then(
      () => undefined,
    )
    this.pending = pending
    void pending.finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    return pending
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
    this.pending = undefined
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
