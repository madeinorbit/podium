import { describe, expect, it, vi } from 'vitest'
import { recoverFromVitePreloadError } from './preload-error-recovery'

function preloadError(message: string): VitePreloadErrorEvent {
  const event = new Event('vite:preloadError', { cancelable: true }) as VitePreloadErrorEvent
  event.payload = new TypeError(message)
  return event
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

describe('Vite preload-error recovery', () => {
  it('reloads once for the same failed chunk in one build', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const first = preloadError('Failed to fetch dynamically imported module: /assets/terminal.js')
    const repeated = preloadError(
      'Failed to fetch dynamically imported module: /assets/terminal.js',
    )

    expect(recoverFromVitePreloadError(first, { build: '/assets/app-a.js', storage, reload })).toBe(
      true,
    )
    expect(first.defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)

    expect(
      recoverFromVitePreloadError(repeated, { build: '/assets/app-a.js', storage, reload }),
    ).toBe(false)
    expect(repeated.defaultPrevented).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('gives another failed chunk and a new app build their own reload', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const terminal = () => preloadError('Failed to fetch /assets/terminal.js')
    const drag = preloadError('Failed to fetch /assets/workspace-tab-drag.js')

    expect(
      recoverFromVitePreloadError(terminal(), { build: '/assets/app-a.js', storage, reload }),
    ).toBe(true)
    expect(
      recoverFromVitePreloadError(drag, { build: '/assets/app-a.js', storage, reload }),
    ).toBe(true)
    expect(
      recoverFromVitePreloadError(terminal(), { build: '/assets/app-b.js', storage, reload }),
    ).toBe(true)
    expect(reload).toHaveBeenCalledTimes(3)
  })

  it('does not reload or cancel the import rejection when storage is unavailable', () => {
    const reload = vi.fn()
    const event = preloadError('Failed to fetch /assets/terminal.js')
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('storage disabled')
      }),
      setItem: vi.fn(),
    }

    expect(recoverFromVitePreloadError(event, { build: '/assets/app-a.js', storage, reload })).toBe(
      false,
    )
    expect(event.defaultPrevented).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
