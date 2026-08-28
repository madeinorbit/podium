import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTabBarMinimized, setTabBarMinimized } from '../lib/tab-bar-minimize'

const route = vi.hoisted(() => ({ focused: true }))
const navigation = vi.hoisted(() => ({ isFocused: () => route.focused }))

vi.mock('expo-router', () => ({ useNavigation: () => navigation }))

const { tabBarScrollState, useMinimizeTabBarOnScroll } = await import(
  './useMinimizeTabBarOnScroll'
)
type TabBarScrollState = import('./useMinimizeTabBarOnScroll').TabBarScrollState

function scrollEvent(y: number) {
  return { nativeEvent: { contentOffset: { y } } } as never
}

afterEach(() => {
  route.focused = true
  setTabBarMinimized(false)
})

describe('tabBarScrollState', () => {
  it('publishes only after enough downward travel', () => {
    const expanded: TabBarScrollState = { anchor: 100, minimized: false }
    expect(tabBarScrollState(125, expanded)).toBe(expanded)
    expect(tabBarScrollState(132, expanded)).toEqual({ anchor: 132, minimized: true })
  })

  it('uses the directional extreme to absorb small reversals', () => {
    const hidden: TabBarScrollState = { anchor: 300, minimized: true }
    const peak = tabBarScrollState(340, hidden)
    expect(peak).toEqual({ anchor: 340, minimized: true })
    expect(tabBarScrollState(310, peak)).toBe(peak)
    expect(tabBarScrollState(292, peak)).toEqual({ anchor: 292, minimized: false })
  })

  it('restores labels near the top', () => {
    expect(tabBarScrollState(20, { anchor: 400, minimized: true })).toEqual({
      anchor: 20,
      minimized: false,
    })
  })

  it('ignores stale momentum from the tab that just lost focus', () => {
    const { result, rerender } = renderHook(() => useMinimizeTabBarOnScroll())
    const oldTabOnScroll = result.current.onScroll

    act(() => oldTabOnScroll(scrollEvent(100)))
    expect(getTabBarMinimized()).toBe(true)

    route.focused = false
    rerender()
    expect(result.current.onScroll).toBe(oldTabOnScroll)

    // TabBar expands on route change before the retained old tab finishes its
    // momentum. That late event must not reclaim the global chrome state.
    act(() => {
      setTabBarMinimized(false)
      oldTabOnScroll(scrollEvent(200))
    })
    expect(getTabBarMinimized()).toBe(false)
  })
})
