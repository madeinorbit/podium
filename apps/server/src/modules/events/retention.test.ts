import { describe, expect, it, vi } from 'vitest'
import { EventLogRetention } from './retention'

describe('EventLogRetention [spec:SP-c29e]', () => {
  it('plans once, runs bounded delete units to completion, and reports metrics', async () => {
    const plan = { cutoff: '2026-01-01T00:00:00.000Z', capThroughId: 10 }
    const planEventPrune = vi.fn(() => plan)
    const deleted = [500, 500, 40]
    const pruneEventBatch = vi.fn(() => deleted.shift() ?? 0)
    const onMetrics = vi.fn()
    const retention = new EventLogRetention(
      { planEventPrune, pruneEventBatch },
      { batchSize: 500, onMetrics },
    )

    const result = await retention.pruneNow()

    expect(planEventPrune).toHaveBeenCalledOnce()
    expect(planEventPrune).toHaveBeenCalledWith({
      maxAgeDays: 14,
      maxRows: 50_000,
    })
    expect(pruneEventBatch).toHaveBeenCalledTimes(3)
    expect(pruneEventBatch).toHaveBeenCalledWith(plan, 500)
    expect(result.deleted).toBe(1_040)
    expect(result.metrics).toMatchObject({ outcome: 'completed', units: 4 })
    expect(onMetrics).toHaveBeenCalledWith(result.metrics)
  })

  it('coalesces overlapping requests into the current job plus one rerun', async () => {
    let monotonicMs = 0
    let planId = 0
    const callsByPlan = new Map<number, number>()
    const planEventPrune = vi.fn(() => ({
      cutoff: '2026-01-01T00:00:00.000Z',
      capThroughId: ++planId,
    }))
    const pruneEventBatch = vi.fn((plan: { capThroughId: number }) => {
      monotonicMs += 13
      const calls = callsByPlan.get(plan.capThroughId) ?? 0
      callsByPlan.set(plan.capThroughId, calls + 1)
      return calls === 0 && plan.capThroughId === 1 ? 500 : 0
    })
    const retention = new EventLogRetention(
      { planEventPrune, pruneEventBatch },
      { batchSize: 500, now: () => monotonicMs },
    )

    const first = retention.pruneNow()
    const second = retention.pruneNow()
    const third = retention.pruneNow()
    await Promise.all([first, second, third])

    expect(planEventPrune).toHaveBeenCalledTimes(2)
  })

  it('runs a coalesced rerun before propagating an active-pass failure', async () => {
    const error = new Error('plan failed')
    const plan = { cutoff: '2026-01-01T00:00:00.000Z', capThroughId: 10 }
    const planEventPrune = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error
      })
      .mockReturnValue(plan)
    const pruneEventBatch = vi.fn(() => 0)
    const retention = new EventLogRetention({ planEventPrune, pruneEventBatch })

    const first = retention.pruneNow()
    const second = retention.pruneNow()
    const results = await Promise.allSettled([first, second])

    expect(results).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ])
    expect(planEventPrune).toHaveBeenCalledTimes(2)
    expect(pruneEventBatch).toHaveBeenCalledOnce()
  })

  it('dispose cancels a yielded job before another delete unit starts', async () => {
    let nowMs = 0
    const planEventPrune = vi.fn(() => ({
      cutoff: '2026-01-01T00:00:00.000Z',
      capThroughId: 10,
    }))
    const pruneEventBatch = vi.fn(() => {
      nowMs += 13
      return 500
    })
    const retention = new EventLogRetention(
      { planEventPrune, pruneEventBatch },
      { batchSize: 500, now: () => nowMs },
    )
    setTimeout(() => retention.dispose(), 0)

    const result = await retention.pruneNow()

    expect(planEventPrune).toHaveBeenCalledOnce()
    expect(pruneEventBatch).toHaveBeenCalledTimes(1)
    expect(result.metrics.outcome).toBe('cancelled')
  })
})
