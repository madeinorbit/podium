import { describe, expect, it, vi } from 'vitest'
import { runTimeBudgetedJob } from './time-budget'

describe('runTimeBudgetedJob [spec:SP-c29e]', () => {
  it('yields by macrotask before starting the next bounded unit', async () => {
    let nowMs = 0
    let units = 0
    const order: string[] = []
    setTimeout(() => order.push('timer'), 0)

    const metrics = await runTimeBudgetedJob(
      () => {
        order.push('unit')
        units++
        nowMs += 5
        return units === 5 ? 'done' : 'continue'
      },
      { sliceBudgetMs: 8, now: () => nowMs },
    )

    expect(order.slice(0, 4)).toEqual(['unit', 'unit', 'timer', 'unit'])
    expect(metrics).toEqual({
      outcome: 'completed',
      units: 5,
      yields: 2,
      totalDurationMs: 25,
      maxUninterruptedSliceMs: 10,
      exceededPlacementThreshold: false,
    })
  })

  it('stops before another unit when shutdown aborts at a yield boundary', async () => {
    const controller = new AbortController()
    let nowMs = 0
    let units = 0
    setTimeout(() => controller.abort(), 0)

    const metrics = await runTimeBudgetedJob(
      () => {
        units++
        nowMs += 5
        return 'continue'
      },
      { sliceBudgetMs: 8, signal: controller.signal, now: () => nowMs },
    )

    expect(units).toBe(2)
    expect(metrics).toMatchObject({
      outcome: 'cancelled',
      units: 2,
      yields: 1,
      maxUninterruptedSliceMs: 10,
    })
  })

  it('flags jobs whose total duration exceeds the worker/janitor placement threshold', async () => {
    let nowMs = 0
    const metrics = await runTimeBudgetedJob(
      () => {
        nowMs += 51
        return 'done'
      },
      { now: () => nowMs },
    )

    expect(metrics.totalDurationMs).toBe(51)
    expect(metrics.exceededPlacementThreshold).toBe(true)
  })

  it('records failed-job metrics without replacing the unit error', async () => {
    let nowMs = 0
    const onMetrics = vi.fn()
    const error = new Error('unit failed')

    await expect(
      runTimeBudgetedJob(
        () => {
          nowMs += 7
          throw error
        },
        { now: () => nowMs, onMetrics },
      ),
    ).rejects.toBe(error)
    expect(onMetrics).toHaveBeenCalledWith({
      outcome: 'failed',
      units: 1,
      yields: 0,
      totalDurationMs: 7,
      maxUninterruptedSliceMs: 7,
      exceededPlacementThreshold: false,
    })
  })

  it('rethrows undefined when a unit throws undefined', async () => {
    const settled = runTimeBudgetedJob(() => {
      throw undefined
    }).then(
      () => 'resolved',
      (reason) => ({ rejected: reason }),
    )

    await expect(settled).resolves.toEqual({ rejected: undefined })
  })
})
