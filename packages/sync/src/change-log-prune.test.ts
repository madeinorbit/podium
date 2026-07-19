import { describe, expect, it, vi } from 'vitest'
import { CHANGE_PRUNE_BATCH_ROWS, pruneChangeLog } from './change-log'

describe('pruneChangeLog [spec:SP-c29e]', () => {
  it('runs bounded delete units until the repository reports a short batch', async () => {
    const batches = [CHANGE_PRUNE_BATCH_ROWS, CHANGE_PRUNE_BATCH_ROWS, 17]
    const plan = { thresholdSeq: 217 }
    const planChangePrune = vi.fn(() => plan)
    const pruneChangeBatch = vi.fn(() => batches.shift() ?? 0)
    const onMetrics = vi.fn()

    const result = await pruneChangeLog(
      { planChangePrune, pruneChangeBatch },
      { keepRows: 20_000, maxAgeMs: 3_000, now: 10_000, onMetrics },
    )

    expect(planChangePrune).toHaveBeenCalledOnce()
    expect(planChangePrune).toHaveBeenCalledWith({
      keepRows: 20_000,
      maxAgeMs: 3_000,
      now: 10_000,
    })
    expect(pruneChangeBatch).toHaveBeenCalledTimes(3)
    expect(pruneChangeBatch).toHaveBeenCalledWith(plan, CHANGE_PRUNE_BATCH_ROWS)
    expect(result.deleted).toBe(CHANGE_PRUNE_BATCH_ROWS * 2 + 17)
    expect(result.metrics).toMatchObject({ outcome: 'completed', units: 4 })
    expect(onMetrics).toHaveBeenCalledWith(result.metrics)
  })

  it('keeps the threshold snapshot fixed when rows append between delete units', async () => {
    const plan = { thresholdSeq: 200 }
    const planChangePrune = vi.fn(() => plan)
    const pruneChangeBatch = vi
      .fn()
      .mockImplementationOnce(() => CHANGE_PRUNE_BATCH_ROWS)
      .mockImplementationOnce((seenPlan) => {
        expect(seenPlan).toBe(plan)
        return 0
      })

    await pruneChangeLog(
      { planChangePrune, pruneChangeBatch },
      { keepRows: 20_000, maxAgeMs: 3_000, now: 10_000 },
    )

    expect(planChangePrune).toHaveBeenCalledOnce()
    expect(pruneChangeBatch).toHaveBeenCalledTimes(2)
  })
})
