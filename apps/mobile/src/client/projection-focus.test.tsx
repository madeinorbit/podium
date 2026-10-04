import { act, cleanup, render, screen } from '@testing-library/react'
import { IsFocusedContext } from 'expo-router/build/react-navigation/core/useIsFocused'
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { afterEach, expect, it } from 'vitest'
import { useProjectionFocus } from './projection-focus'

afterEach(cleanup)
function Probe() { return <span data-testid="focus">{useProjectionFocus() ? 'active' : 'hidden'}</span> }

it('follows the native tab focus context and leaves root chrome active', () => {
  const root = render(<Probe />)
  expect(screen.getByTestId('focus').textContent).toBe('active')
  root.rerender(<IsFocusedContext.Provider value={false}><Probe /></IsFocusedContext.Provider>)
  expect(screen.getByTestId('focus').textContent).toBe('hidden')
  root.rerender(<IsFocusedContext.Provider value={true}><Probe /></IsFocusedContext.Provider>)
  expect(screen.getByTestId('focus').textContent).toBe('active')
})

it('follows web navigator blur and focus events without mounting another navigator', () => {
  let focused = true
  const listeners = new Map<string, Set<() => void>>()
  const navigation = {
    isFocused: () => focused,
    addListener: (event: string, wake: () => void) => {
      const group = listeners.get(event) ?? new Set<() => void>()
      listeners.set(event, group); group.add(wake)
      return () => { group.delete(wake) }
    },
  }
  render(<NavigationContext.Provider value={navigation as never}><Probe /></NavigationContext.Provider>)
  const emit = (event: string) => act(() => { for (const wake of listeners.get(event) ?? []) wake() })
  focused = false; emit('blur')
  expect(screen.getByTestId('focus').textContent).toBe('hidden')
  focused = true; emit('focus')
  expect(screen.getByTestId('focus').textContent).toBe('active')
  cleanup()
  expect([...listeners.values()].every(group => group.size === 0)).toBe(true)
})
