import { DeadlineClock, now, setClockWakeSource } from '@podium/mobx-helpers'
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { browserClockWakeSource } from './clock-wake-source'

afterEach(() => { setClockWakeSource(undefined); vi.useRealTimers(); vi.unstubAllGlobals() })

it('rechecks deadlines on visibilitychange, focus and pageshow and removes listeners', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  const doc = new EventTarget(), win = new EventTarget()
  let visibility = 'visible'
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility })
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win)
  setClockWakeSource(browserClockWakeSource)
  const removeDoc = vi.spyOn(doc, 'removeEventListener')
  const removeWin = vi.spyOn(win, 'removeEventListener')
  const clock = new DeadlineClock(), values: boolean[] = [], times: number[] = []
  const stop = autorun(() => values.push(clock.reached(1500)))
  const stopLabel = autorun(() => times.push(now(1000)))
  try {
    visibility = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(2000)
    visibility = 'visible'; doc.dispatchEvent(new Event('visibilitychange'))
    expect(values).toEqual([false, true])
    vi.setSystemTime(2500); win.dispatchEvent(new Event('focus'))
    expect(times.at(-1)).toBe(2500)
    vi.setSystemTime(3000); win.dispatchEvent(new Event('pageshow'))
    expect(times.at(-1)).toBe(3000)
    expect(values).toEqual([false, true])
  } finally { stop(); stopLabel(); clock.clear(); setClockWakeSource(undefined); vi.unstubAllGlobals() }
  expect(vi.getTimerCount()).toBe(0)
  expect(removeDoc).toHaveBeenCalledTimes(1)
  expect(removeWin).toHaveBeenCalledTimes(2)
})
