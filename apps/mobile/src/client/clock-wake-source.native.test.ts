import { DeadlineClock, now, setClockWakeSource } from '@podium/mobx-helpers'
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'

const appState = vi.hoisted(() => ({
  currentState: 'active',
  wake: undefined as (() => void) | undefined,
  remove: vi.fn(),
  addEventListener: vi.fn(),
}))
vi.mock('react-native', () => ({ AppState: appState }))
import { platformClockWakeSource } from './clock-wake-source.native'

afterEach(() => { setClockWakeSource(undefined); vi.useRealTimers() })

it('pauses and rechecks phone clocks on AppState changes with one demand-owned listener', () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  appState.currentState = 'active'
  appState.addEventListener.mockImplementation((_event, wake) => {
    appState.wake = wake
    return { remove: appState.remove }
  })
  setClockWakeSource(platformClockWakeSource)
  expect(appState.addEventListener).not.toHaveBeenCalled()
  const clock = new DeadlineClock(), deadlines: boolean[] = [], times: number[] = []
  const a = autorun(() => deadlines.push(clock.reached(1500)))
  const b = autorun(() => times.push(now(1000)))
  try {
    expect(appState.addEventListener).toHaveBeenCalledTimes(1)
    appState.currentState = 'background'; appState.wake!()
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(2000)
    expect(deadlines).toEqual([false])
    appState.currentState = 'active'; appState.wake!()
    expect(deadlines).toEqual([false, true])
    expect(times.at(-1)).toBe(2000)
    a(); expect(appState.remove).not.toHaveBeenCalled()
    b(); expect(appState.remove).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally { a(); b(); clock.clear() }
})
