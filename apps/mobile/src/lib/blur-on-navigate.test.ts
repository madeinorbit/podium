import { TextInput } from 'react-native'
import { afterEach, describe, expect, it } from 'vitest'
import { installBlurOnNavigate } from './blur-on-navigate.web'

/**
 * The shim over react-native-web's `TextInput.State` [POD-402].
 *
 * Tested because both sides of it belong to somebody else: react-navigation
 * decides what it calls, react-native-web decides what exists, and the failure
 * when they drift is a TypeError inside a navigation callback — which the app
 * survives, so nothing here would go red on its own.
 */
type State = Record<string, unknown>
const state = () => (TextInput as unknown as { State: State }).State

const original = { ...state() }
afterEach(() => {
  for (const key of Object.keys(state())) delete state()[key]
  Object.assign(state(), original)
})

describe('installBlurOnNavigate', () => {
  it('gives react-navigation the name it actually calls', () => {
    // The premise: RNW ships `currentlyFocusedField`, the stack calls
    // `currentlyFocusedInput`. If this stops being true, so does the shim.
    expect(state().currentlyFocusedField).toBeTypeOf('function')

    expect(installBlurOnNavigate()).toBe('installed')
    expect(state().currentlyFocusedInput).toBeTypeOf('function')
  })

  it('returns whatever RNW considers focused, so .blur() lands on it', () => {
    installBlurOnNavigate()
    const node = { blur: () => {}, focus: () => {} }
    state().currentlyFocusedField = () => node
    expect((state().currentlyFocusedInput as () => unknown)()).toBe(node)
  })

  it('defers to a real implementation instead of shadowing it', () => {
    const theirs = () => null
    state().currentlyFocusedInput = theirs
    expect(installBlurOnNavigate()).toBe('already-supported')
    expect(state().currentlyFocusedInput).toBe(theirs)
  })

  it('declines rather than throwing when there is nothing to bridge', () => {
    delete state().currentlyFocusedField
    delete state().currentlyFocusedInput
    expect(installBlurOnNavigate()).toBe('unavailable')
  })
})
