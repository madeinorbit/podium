import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTabBarMinimized,
  minimizeDecision,
  setTabBarMinimized,
  subscribeTabBarMinimized,
} from './tab-bar-minimize'

afterEach(() => setTabBarMinimized(false))

describe('minimizeDecision', () => {
  it('folds going down and unfolds coming back up', () => {
    expect(minimizeDecision(300, 100)).toEqual({ minimized: true, anchor: 300 })
    expect(minimizeDecision(100, 300)).toEqual({ minimized: false, anchor: 100 })
  })

  it('ignores travel too small to be a direction', () => {
    // Without this the bar flickers on every thumb tremor mid-list.
    expect(minimizeDecision(305, 300)).toBeNull()
    expect(minimizeDecision(295, 300)).toBeNull()
  })

  it('keeps the bar up near the top whichever way you came', () => {
    // At the top there is nothing to make room for, and arriving folded would
    // hide the labels on a list that has not been scrolled.
    expect(minimizeDecision(0, 400)).toEqual({ minimized: false, anchor: 0 })
    expect(minimizeDecision(10, 0)).toEqual({ minimized: false, anchor: 10 })
  })

  it('measures travel from the last decision, not the last event', () => {
    // A slow drag arrives as many sub-threshold deltas; anchoring on the last
    // DECISION is what lets them add up to one.
    const first = minimizeDecision(308, 300)
    expect(first).toBeNull()
    expect(minimizeDecision(316, 300)).toEqual({ minimized: true, anchor: 316 })
  })
})

describe('the store', () => {
  it('notifies subscribers only when the state actually changes', () => {
    const seen = vi.fn()
    const stop = subscribeTabBarMinimized(seen)

    setTabBarMinimized(true)
    setTabBarMinimized(true)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(getTabBarMinimized()).toBe(true)

    setTabBarMinimized(false)
    expect(seen).toHaveBeenCalledTimes(2)

    stop()
    setTabBarMinimized(true)
    expect(seen).toHaveBeenCalledTimes(2)
  })
})
