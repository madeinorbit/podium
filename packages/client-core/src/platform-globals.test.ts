import { afterEach, describe, expect, test } from 'vitest'
import { hasDomWindow } from './platform-globals'

/** React Native's `window`: the object exists (it IS `global`), the DOM does not. */
function installNativeWindow(extra: Record<string, unknown> = {}): void {
  ;(globalThis as { window?: unknown }).window = { navigator: {}, ...extra }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('hasDomWindow', () => {
  test('is false where there is no window at all (node, SSR)', () => {
    expect(hasDomWindow()).toBe(false)
  })

  test('is false for a React Native window, which has no DOM listeners', () => {
    installNativeWindow()
    expect(hasDomWindow()).toBe(false)
  })

  test('is true once the window carries addEventListener', () => {
    installNativeWindow({ addEventListener: () => {}, removeEventListener: () => {} })
    expect(hasDomWindow()).toBe(true)
  })
})
