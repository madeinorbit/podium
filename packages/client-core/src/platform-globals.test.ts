import { afterEach, describe, expect, test, vi } from 'vitest'
import { hasDomWindow, hasMessageChannel } from './platform-globals'

/** React Native's `window`: the object exists (it IS `global`), the DOM does not. */
function installNativeWindow(extra: Record<string, unknown> = {}): void {
  ;(globalThis as { window?: unknown }).window = { navigator: {}, ...extra }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  vi.unstubAllGlobals()
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

describe('hasMessageChannel', () => {
  test('is true where the host can post a message to itself', () => {
    expect(hasMessageChannel()).toBe(true)
  })

  test('is false on a host without it — React Native, which ships no MessageChannel', () => {
    vi.stubGlobal('MessageChannel', undefined)
    expect(hasMessageChannel()).toBe(false)
  })
})
