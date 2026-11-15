import { asSessionId } from '@podium/model'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { KeyboardEvent } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type TerminalDom from './TerminalDom'

const native = vi.hoisted(() => ({
  os: 'ios',
  window: { width: 402, height: 874, scale: 3, fontScale: 1 },
  bottom: 34,
  metrics: undefined as KeyboardEvent['endCoordinates'] | undefined,
  dom: undefined as ComponentProps<typeof TerminalDom>['dom'],
  listeners: new Map<string, Set<(event: KeyboardEvent) => void>>(),
  hub: { registerRenderedSession: vi.fn(), detach: vi.fn() },
}))

// UIKit supplies the frame and window size. Keep the real pane and shared
// keyboard hook together so their combined padding, including safeBottom, is tested.
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  return {
    ...rn,
    Platform: {
      ...rn.Platform,
      get OS() {
        return native.os
      },
    },
    useWindowDimensions: () => native.window,
    Keyboard: {
      metrics: () => native.metrics,
      addListener: (name: string, listener: (event: KeyboardEvent) => void) => {
        const listeners = native.listeners.get(name) ?? new Set()
        listeners.add(listener)
        native.listeners.set(name, listeners)
        return { remove: () => listeners.delete(listener) }
      },
    },
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, right: 0, bottom: native.bottom, left: 0 }),
}))
vi.mock('../client/hooks', () => ({ useHub: () => native.hub, useConnected: () => true }))
vi.mock('../client/use-session-context', () => ({
  useSessionContextSession: () => undefined,
  useSessionContextSpawnPending: () => false,
}))
vi.mock('./TerminalDom', () => ({
  default: ({ dom }: ComponentProps<typeof TerminalDom>) => {
    native.dom = dom
    return <div data-testid="terminal-dom" />
  },
}))

const { TerminalPane } = await import('./TerminalPane.native')
const pane = () => <TerminalPane sessionId={asSessionId('keyboard-session')} active />
const padding = () => screen.getByTestId('terminal-keyboard-avoider').style.paddingBottom
const frame = (screenY: number, height: number): KeyboardEvent => ({
  startCoordinates: { screenX: 0, screenY, width: native.window.width, height },
  endCoordinates: { screenX: 0, screenY, width: native.window.width, height },
  duration: 250,
  easing: 'keyboard',
  isEventFromThisApp: true,
})
const emit = (name: string, event = frame(native.window.height, 0)) =>
  act(() => {
    for (const listener of native.listeners.get(name) ?? []) listener(event)
  })
const keyboard = (screenY: number, height: number) =>
  emit('keyboardWillChangeFrame', frame(screenY, height))

beforeEach(() => {
  native.os = 'ios'
  native.window = { width: 402, height: 874, scale: 3, fontScale: 1 }
  native.bottom = 34
  native.metrics = undefined
  native.dom = undefined
})
afterEach(() => {
  cleanup()
  native.listeners.clear()
  vi.clearAllMocks()
})

describe('native console keyboard clearance', () => {
  it('hides the webview accessory and leaves native insets to the console screen', () => {
    render(pane())
    expect(native.dom).toMatchObject({
      hideKeyboardAccessoryView: true,
      scrollEnabled: false,
      automaticallyAdjustContentInsets: false,
      contentInsetAdjustmentBehavior: 'never',
    })
    expect(padding()).toBe('0px')
    expect(screen.getByTestId('terminal-dom')).toBeTruthy()
  })

  it.each([
    { device: '17 Pro', windowHeight: 874, keyboardHeight: 352, bottom: 34 },
    { device: '16e', windowHeight: 844, keyboardHeight: 336, bottom: 34 },
    { device: 'SE', windowHeight: 667, keyboardHeight: 291, bottom: 0 },
  ])('clears the software keyboard on $device without paying safeBottom twice', ({
    windowHeight,
    keyboardHeight,
    bottom,
  }) => {
    native.window = { ...native.window, height: windowHeight }
    native.bottom = bottom
    render(pane())
    keyboard(windowHeight - keyboardHeight, keyboardHeight)
    expect(padding()).toBe(`${keyboardHeight - bottom}px`)
    // The pane ends at windowHeight - safeBottom before its own padding.
    expect(windowHeight - bottom - Number.parseFloat(padding())).toBe(windowHeight - keyboardHeight)
  })

  it('follows the hardware shortcut bar and software keyboard without a fixed gap', () => {
    render(pane())
    keyboard(522, 352)
    expect(padding()).toBe('318px')
    keyboard(805, 69)
    expect(padding()).toBe('35px')
    emit('keyboardWillHide', frame(805, 69))
    expect(padding()).toBe('35px')
    keyboard(854, 20)
    expect(padding()).toBe('0px')
    keyboard(874, 0)
    expect(padding()).toBe('0px')
    keyboard(522, 352)
    expect(padding()).toBe('318px')
  })

  it('clears padding on frame dismissal and explicit hide, including after a resize', () => {
    const view = render(pane())
    keyboard(522, 352)
    keyboard(874, 352)
    expect(padding()).toBe('0px')
    keyboard(522, 352)
    emit('keyboardWillHide')
    expect(padding()).toBe('0px')
    emit('keyboardDidHide')
    native.window = { ...native.window, height: 1024 }
    view.rerender(pane())
    expect(padding()).toBe('0px')
  })

  it('starts with the existing keyboard frame when returning to a focused console', () => {
    native.metrics = frame(522, 352).endCoordinates
    render(pane())
    expect(padding()).toBe('318px')
  })

  it('catches a keyboard that finishes opening after the pane missed its will-change event', () => {
    render(pane())
    emit('keyboardDidShow', frame(522, 352))
    expect(padding()).toBe('318px')
  })

  it('recalculates rotation when the window or keyboard notification arrives first', () => {
    const view = render(pane())
    keyboard(522, 352)
    native.window = { ...native.window, width: 874, height: 402 }
    native.bottom = 21
    view.rerender(pane())
    expect(padding()).toBe('0px')
    keyboard(219, 183)
    expect(padding()).toBe('162px')
    // Rotate back, this time delivering the new frame before the window change.
    keyboard(522, 352)
    expect(padding()).toBe('0px')
    native.window = { ...native.window, width: 402, height: 874 }
    native.bottom = 34
    view.rerender(pane())
    expect(padding()).toBe('318px')
  })

  it('recalculates a window size change even without a new keyboard notification', () => {
    const view = render(pane())
    keyboard(522, 352)
    native.window = { ...native.window, height: 740 }
    view.rerender(pane())
    expect(padding()).toBe('184px')
  })

  it('leaves Android keyboard resizing to its window', () => {
    native.os = 'android'
    render(pane())
    emit('keyboardDidShow', frame(522, 352))
    expect(padding()).toBe('0px')
    expect(native.listeners.has('keyboardWillChangeFrame')).toBe(false)
  })

  it('removes every keyboard subscription when the console closes', () => {
    const view = render(pane())
    expect(native.listeners.get('keyboardWillChangeFrame')?.size).toBe(1)
    view.unmount()
    expect([...native.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
  })
})
