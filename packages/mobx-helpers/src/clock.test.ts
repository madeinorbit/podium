import { autorun, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clockStore, DeadlineClock, nextUp, now, nowForAge, refreshClocks, setClockActive } from './clock'

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

afterEach(() => { setClockActive(true); vi.useRealTimers() })

describe('on-demand clock', () => {
  it('does zero clock work over an idle minute and shares one timer per observed precision', () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000)
    for (let i = 0; i < 100; i++) { now(1000); new DeadlineClock().reached(200_000) }
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(vi.getTimerCount()).toBe(0)
    const one: number[] = [], two: number[] = [], minutes: number[] = []
    const a = autorun(() => one.push(now(1000)))
    const b = autorun(() => two.push(now(1000)))
    const c = autorun(() => minutes.push(now(60_000)))
    try {
      expect(vi.getTimerCount()).toBe(2)
      vi.advanceTimersByTime(1000)
      expect(one).toEqual([160_000, 161_000])
      expect(two).toEqual(one)
      expect(minutes).toEqual([160_000])
      a(); expect(vi.getTimerCount()).toBe(2)
      b(); expect(vi.getTimerCount()).toBe(1)
    } finally { a(); b(); c() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('changes age-label precision at one hour and releases the second clock', () => {
    vi.useFakeTimers(); vi.setSystemTime(3_598_000)
    const values: number[] = []
    const stop = autorun(() => values.push(nowForAge(0)))
    try {
      vi.advanceTimersByTime(2000)
      expect(values.at(-1)).toBe(3_600_000)
      const length = values.length
      vi.advanceTimersByTime(59_999)
      expect(values).toHaveLength(length)
      vi.advanceTimersByTime(1)
      expect(values.at(-1)).toBe(3_660_000)
    } finally { stop() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fires an exact deadline within 50ms and wakes only crossed readers', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const clock = new DeadlineClock(), values: boolean[][] = [[], []]
    const a = autorun(() => values[0]!.push(clock.reached(1250)))
    const b = autorun(() => values[1]!.push(clock.reached(1600)))
    try {
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(249)
      expect(values).toEqual([[false], [false]])
      vi.advanceTimersByTime(1)
      expect(values).toEqual([[false, true], [false]])
      expect(Date.now() - 1250).toBeLessThanOrEqual(50)
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(350)
      expect(values).toEqual([[false, true], [false, true]])
      expect(vi.getTimerCount()).toBe(0)
    } finally { a(); b(); clock.clear() }
  })

  it('rechecks native and document wake boundaries immediately after suspension', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const clock = new DeadlineClock(), values: boolean[] = [], times: number[] = []
    const a = autorun(() => values.push(clock.reached(1500)))
    const b = autorun(() => times.push(now(1000)))
    try {
      setClockActive(false)
      expect(vi.getTimerCount()).toBe(0)
      vi.setSystemTime(2000)
      expect(values).toEqual([false])
      setClockActive(true)
      expect(values).toEqual([false, true])
      expect(times.at(-1)).toBe(2000)
      vi.setSystemTime(3000); refreshClocks()
      expect(times.at(-1)).toBe(3000)
    } finally { a(); b(); clock.clear() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps React snapshots stable and creates no timer for an unmounted or disabled store', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const store = clockStore(() => now(1000)), changed = vi.fn()
    vi.setSystemTime(1500)
    expect(store.getSnapshot()).toBe(1000)
    expect(vi.getTimerCount()).toBe(0)
    const stop = store.subscribe(changed)
    expect(store.getSnapshot()).toBe(1500)
    expect(vi.getTimerCount()).toBe(1)
    stop()
    const disabled = clockStore(() => now(1000), false)
    disabled.subscribe(changed)()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains >= and strict > answers from the former deadline clock on identical fixtures', () => {
    const fixtures = [-1, 0, 1, 50, 100, 200, Infinity, NaN]
    const clock = new DeadlineClock(0)
    for (const at of [0, 1, 50, 100, 200]) {
      clock.advance(at)
      for (const deadline of fixtures) {
        expect(clock.reached(deadline)).toBe(at >= deadline)
        expect(clock.passed(deadline)).toBe(at > deadline)
      }
    }
    clock.clear()
  })
})

it('rechecks deadlines on visibilitychange, focus and pageshow and removes listeners', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  const doc = new EventTarget(), win = new EventTarget()
  let visibility = 'visible'
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility })
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win)
  const clock = new DeadlineClock(), values: boolean[] = []
  const stop = autorun(() => values.push(clock.reached(1500)))
  try {
    visibility = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(2000)
    visibility = 'visible'; doc.dispatchEvent(new Event('visibilitychange'))
    expect(values).toEqual([false, true])
    win.dispatchEvent(new Event('focus')); win.dispatchEvent(new Event('pageshow'))
    expect(values).toEqual([false, true])
  } finally { stop(); clock.clear(); vi.unstubAllGlobals() }
  expect(vi.getTimerCount()).toBe(0)
})
