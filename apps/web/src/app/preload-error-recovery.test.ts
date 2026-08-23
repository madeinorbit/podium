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
  it('reloads once for the same module URL across browser error wording', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const first = preloadError(
      'Failed to fetch dynamically imported module: https://podium.test/assets/terminal.js',
    )
    const repeated = preloadError(
      'error loading dynamically imported module: /assets/terminal.js',
    )

    expect(
      recoverFromVitePreloadError(first, {
        build: 'https://podium.test/assets/app-a.js',
        storage,
        reload,
      }),
    ).toBe(true)
    expect(first.defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)

    expect(
      recoverFromVitePreloadError(repeated, {
        build: 'https://podium.test/assets/app-a.js',
        storage,
        reload,
      }),
    ).toBe(false)
    expect(repeated.defaultPrevented).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('gives distinct module URLs their own reload', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const terminal = preloadError('Failed to fetch dynamically imported module: /terminal.js')
    const drag = preloadError('Failed to fetch dynamically imported module: /workspace-drag.js')
    const options = {
      build: 'https://podium.test/assets/app-a.js',
      storage,
      reload,
    }

    expect(recoverFromVitePreloadError(terminal, options)).toBe(true)
    expect(recoverFromVitePreloadError(drag, options)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('does not let generic WebKit wording suppress a distinct chunk', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const terminal = preloadError('Importing a module script failed.')
    const drag = preloadError('Importing a module script failed.')

    expect(
      recoverFromVitePreloadError(terminal, { build: '/assets/app-a.js', storage, reload }),
    ).toBe(true)
    expect(
      recoverFromVitePreloadError(drag, { build: '/assets/app-a.js', storage, reload }),
    ).toBe(true)
    expect(terminal.defaultPrevented).toBe(true)
    expect(drag.defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('bounds a persistent URL-less failure despite changing browser wording', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const errors = [
      preloadError('Importing a module script failed.'),
      preloadError('Load failed'),
      preloadError('Failed to fetch dynamically imported module'),
    ]

    expect(
      recoverFromVitePreloadError(errors[0]!, { build: '/assets/app-a.js', storage, reload }),
    ).toBe(true)
    expect(
      recoverFromVitePreloadError(errors[1]!, { build: '/assets/app-a.js', storage, reload }),
    ).toBe(true)
    expect(
      recoverFromVitePreloadError(errors[2]!, { build: '/assets/app-a.js', storage, reload }),
    ).toBe(false)
    expect(errors[2]!.defaultPrevented).toBe(false)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('gives an expired guard and a new app build a fresh budget', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const recover = (build: string, now: number) =>
      recoverFromVitePreloadError(preloadError('Importing a module script failed.'), {
        build,
        storage,
        reload,
        now,
      })

    expect(recover('/assets/app-a.js', 1_000)).toBe(true)
    expect(recover('/assets/app-a.js', 1_001)).toBe(true)
    expect(recover('/assets/app-a.js', 1_002)).toBe(false)
    expect(recover('/assets/app-b.js', 1_003)).toBe(true)
    expect(recover('/assets/app-b.js', 5 * 60_000 + 1_003)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(4)
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
