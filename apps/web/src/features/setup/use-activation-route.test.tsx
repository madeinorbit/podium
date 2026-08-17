import { ONBOARDING_ACTIVE_KEY } from '@podium/client-core/ui-state'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** A minimal routed ui-state: the two operations the hook uses, plus a real
 *  subscription so the value it reads back is the value it wrote. */
const store = vi.hoisted(() => {
  const values = new Map<string, string>()
  const listeners = new Set<() => void>()
  return {
    values,
    uiState: {
      get: (key: string): string | null => values.get(key) ?? null,
      set: (key: string, value: string | null): void => {
        if (value === null) values.delete(key)
        else values.set(key, value)
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
})

vi.mock('@/app/store', () => ({
  useStoreSelector: <T,>(select: (state: { uiState: unknown }) => T): T =>
    select({ uiState: store.uiState }),
}))

import { useActivationRoute } from './use-activation-route'

afterEach(() => {
  cleanup()
  store.values.clear()
  window.history.replaceState(null, '', '/')
})

describe('useActivationRoute', () => {
  it('marks setup underway on the first step and only finishing retires it', () => {
    const { result } = renderHook(() => useActivationRoute())
    expect(result.current.setupInProgress).toBe(false)

    act(() => result.current.navigate('local-project'))
    expect(result.current.setupInProgress).toBe(true)
    expect(store.values.get(ONBOARDING_ACTIVE_KEY)).toBe('1')
    expect(window.location.search).toBe('?activation=local-project')

    // Stepping back to the first screen is still setup. This is the exact move
    // that used to hand over a half-configured shell: welcome wrote no param,
    // and by then the project step had already added a repo (POD-1200).
    act(() => result.current.navigate('welcome'))
    expect(result.current.setupInProgress).toBe(true)
    expect(window.location.search).toBe('?activation=welcome')

    act(() => result.current.clear())
    expect(result.current.setupInProgress).toBe(false)
    expect(store.values.has(ONBOARDING_ACTIVE_KEY)).toBe(false)
    expect(window.location.search).toBe('')
  })

  it('restores the step from the URL and reports setup underway from storage', () => {
    window.history.replaceState(null, '', '/?activation=agent')
    store.values.set(ONBOARDING_ACTIVE_KEY, '1')

    const { result } = renderHook(() => useActivationRoute())

    expect(result.current.state).toEqual({ route: 'agent' })
    expect(result.current.setupInProgress).toBe(true)
  })

  it('keeps navigate stable so callers can memoize on it', () => {
    const { result, rerender } = renderHook(() => useActivationRoute())
    const first = result.current.navigate
    act(() => result.current.navigate('vps-choice'))
    rerender()
    expect(result.current.navigate).toBe(first)
  })
})
