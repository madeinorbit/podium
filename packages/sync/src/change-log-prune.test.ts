import { describe, expect, it, vi } from 'vitest'
import { CHANGE_PRUNE_BATCH_ROWS, pruneChangeLog } from './change-log'

describe('pruneChangeLog [spec:SP-c29e]', () => {
  it('runs bounded delete units until the repository reports a short batch', async () => {
    const batches = [CHANGE_PRUNE_BATCH_ROWS, CHANGE_PRUNE_BATCH_ROWS, 17]
    const pruneChanges = vi.fn(() => batches.shift() ?? 0)
    const onMetrics = vi.fn()

    const result = await pruneChangeLog(
      { pruneChanges },
      { keepRows: 20_000, maxAgeMs: 3_000, now: 10_000, onMetrics },
    )

    expect(pruneChanges).toHaveBeenCalledTimes(3)
    expect(pruneChanges).toHaveBeenCalledWith({
      keepRows: 20_000,
      maxAgeMs: 3_000,
      now: 10_000,
      batchSize: CHANGE_PRUNE_BATCH_ROWS,
    })
    expect(result.deleted).toBe(CHANGE_PRUNE_BATCH_ROWS * 2 + 17)
    expect(result.metrics).toMatchObject({ outcome: 'completed', units: 3 })
    expect(onMetrics).toHaveBeenCalledWith(result.metrics)
  })
})
