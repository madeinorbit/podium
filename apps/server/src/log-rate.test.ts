import { describe, expect, it } from 'vitest'
import { LogRate } from './log-rate'

describe('LogRate (POD-7036)', () => {
  it('writes the first lines of a window, counts the rest, and reports the count on the next line written', () => {
    let now = 0
    const rate = new LogRate(1_000, 3, () => now)
    const taken = Array.from({ length: 10 }, () => rate.take())
    expect(taken.slice(0, 3)).toEqual([{}, {}, {}])
    expect(taken.slice(3).every((fields) => fields === undefined)).toBe(true)
    now = 1_000
    expect(rate.take()).toEqual({ suppressed: 7 })
    expect(rate.take()).toEqual({})
  })
})
