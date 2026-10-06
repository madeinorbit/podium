import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { DeadlineClock, nextUp } from './clock'

describe('DeadlineClock', () => {
  it('tracks forward ticks and rewinds without waking other deadline readers', () => {
    const clock = new DeadlineClock(100), times: number[] = [], deadlines: boolean[] = []
    const stopTime = autorun(() => times.push(clock.trackedNow()))
    const stopDeadline = autorun(() => deadlines.push(clock.reached(200)))
    try {
      runInAction(() => clock.advance(101))
      runInAction(() => clock.advance(101))
      runInAction(() => clock.advance(99))
      runInAction(() => clock.advance(100))
      expect(times).toEqual([100, 101, 99, 100])
      expect(deadlines).toEqual([false])
      runInAction(() => clock.advance(200))
      expect(times.at(-1)).toBe(200)
      expect(deadlines).toEqual([false, true])
    } finally { stopTime(); stopDeadline(); clock.clear() }
  })

  it('registers no deadlines for untracked time reads and releases the last time reader', () => {
    const clock = new DeadlineClock(100)
    for (let i = 0; i < 100; i++) expect(clock.trackedNow()).toBe(100)
    expect(clock.peekNow()).toBe(100)
    runInAction(() => clock.advance(200))
    expect(clock.crossings).toBe(0)
    const stop = autorun(() => clock.trackedNow())
    stop()
    runInAction(() => clock.advance(300))
    expect(clock.crossings).toBe(0)
    clock.clear()
  })

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
