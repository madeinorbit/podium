import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { DeadlineClock, nextUp } from './clock'

describe('DeadlineClock', () => {
  it('wakes only readers whose deadline is crossed', () => {
    const clock = new DeadlineClock(0), answers: boolean[][] = [[], []]
    const first = autorun(() => { answers[0]!.push(clock.reached(10)) })
    const second = autorun(() => { answers[1]!.push(clock.reached(20)) })
    try {
      runInAction(() => clock.advance(15))
      expect(answers).toEqual([[false, true], [false]])
      expect(clock.crossings).toBe(1)
      runInAction(() => clock.advance(20))
      expect(answers).toEqual([[false, true], [false, true]])
      expect(clock.current).toBe(20)
    } finally { first(); second(); clock.clear() }
  })

  it('tracks rewind and the strict passed boundary', () => {
    const clock = new DeadlineClock(100), answers: boolean[] = []
    const stop = autorun(() => { answers.push(clock.passed(50)) })
    try {
      runInAction(() => clock.advance(50))
      runInAction(() => clock.advance(nextUp(50)))
      expect(answers).toEqual([true, false, true])
    } finally { stop(); clock.clear() }
  })

  it('forgets a deadline when its last observer leaves', () => {
    const clock = new DeadlineClock(0)
    const one = autorun(() => clock.reached(10)), two = autorun(() => clock.reached(10))
    one(); two()
    runInAction(() => clock.advance(20))
    expect(clock.crossings).toBe(0)
    clock.clear()
  })

  it('preserves the adjacent-double and infinity rules', () => {
    expect(nextUp(0)).toBe(Number.MIN_VALUE)
    expect(nextUp(-0)).toBe(Number.MIN_VALUE)
    expect(nextUp(-Number.MIN_VALUE)).toBe(-0)
    expect(nextUp(1)).toBe(1 + Number.EPSILON)
    expect(nextUp(Infinity)).toBe(Infinity)
    expect(nextUp(NaN)).toBeNaN()
  })
})
