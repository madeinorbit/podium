import { modelShares, projectCostShares, usageSummary } from '@podium/client-core/values'
import { lazy } from '@podium/mobx-helpers'
import type { TaskCostRowWire, UsageBucketWire } from '@podium/model'
import { action } from 'mobx'
import type { MobxPool } from './pool'
import { RequestAnswer } from './request-answer'
import { TaskCostView } from './task-cost-view'

interface PulseReading {
  buckets: UsageBucketWire[]
  nowMs: number
}

/** One Pulse opening. Usage commits the harvest before cost.tasks reads it.
 * Concurrent refresh triggers join the same harvest. Both answers publish in
 * one action, and cancellation fences both, so a failed refresh keeps the pair. */
export class PulseView extends RequestAnswer<PulseReading> {
  readonly costs: TaskCostView
  // Stored on open: the loading calendar stays still until a harvest replaces it.
  private readonly openedAt = Date.now()
  private pending: Promise<void> | undefined

  constructor(pool: MobxPool) {
    super()
    this.costs = new TaskCostView(pool)
  }

  @action refresh(
    usage: () => Promise<{ buckets: UsageBucketWire[] }>,
    costs: () => Promise<readonly TaskCostRowWire[]>,
  ): Promise<void> {
    if (this.pending) return this.pending
    const pending = this.load(
      async () => {
        const reading = await usage()
        const tasks = await costs()
        return { buckets: reading.buckets, nowMs: Date.now(), tasks }
      },
      false,
      ({ tasks, ...reading }) => {
        this.costs.answer = tasks
        return reading
      },
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
    return this.costs.projectGroups
      ? projectCostShares(this.costs.projectGroups, this.summary.week.estCostUsd)
      : null
  }

  @action override cancel(): void {
    super.cancel()
    this.pending = undefined
  }

  dispose(): void {
    this.close()
    this.costs.dispose()
  }
}

export function createPulseView(pool: MobxPool): PulseView {
  return new PulseView(pool)
}
