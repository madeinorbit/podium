import { describe, expect, it, vi } from 'vitest'
import { type ChunkRecoveryDeps, retryChunkImport } from '@/lib/chunk-recovery'
import { recoverFromVitePreloadError, retryOnOnline } from './preload-error-recovery'

function preloadError(
  message = 'Failed to fetch dynamically imported module: /assets/terminal.js',
): VitePreloadErrorEvent {
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

function options() {
  return {
    build: 'https://podium.test/assets/app-a.js',
    storage: memoryStorage(),
    reload: vi.fn(),
    isOnline: () => true,
    probe: vi.fn(async () => ({ status: 404 })),
  }
}

describe('Vite preload-error recovery', () => {
  it('leaves the event and reload guard alone offline, without probing', async () => {
    const deps = { ...options(), isOnline: () => false }
    const write = vi.spyOn(deps.storage, 'setItem')
    const event = preloadError()
    expect(await recoverFromVitePreloadError(event, deps)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
    expect(deps.probe).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('reloads once for the same missing URL across browser error wording', async () => {
    const deps = options()
    const first = preloadError(
      'Failed to fetch dynamically imported module: https://podium.test/assets/terminal.js',
    )
    const repeated = preloadError('error loading dynamically imported module: /assets/terminal.js')
    expect(await recoverFromVitePreloadError(first, deps)).toBe(true)
    expect(first.defaultPrevented).toBe(true)
    expect(await recoverFromVitePreloadError(repeated, deps)).toBe(false)
    expect(repeated.defaultPrevented).toBe(false)
    expect(deps.reload).toHaveBeenCalledOnce()
    expect(deps.probe).toHaveBeenCalledWith('https://podium.test/assets/terminal.js')
  })

  it('gives distinct missing URLs their own reload within the existing build budget', async () => {
    const deps = options()
    const events = ['/terminal.js', '/workspace-drag.js', '/settings.js'].map((url) =>
      preloadError(`Failed to fetch dynamically imported module: ${url}`),
    )
    expect(await recoverFromVitePreloadError(events[0]!, deps)).toBe(true)
    expect(await recoverFromVitePreloadError(events[1]!, deps)).toBe(true)
    expect(await recoverFromVitePreloadError(events[2]!, deps)).toBe(false)
    expect(events[2]!.defaultPrevented).toBe(false)
    expect(deps.reload).toHaveBeenCalledTimes(2)
  })

  it('retains the guard across concurrent failures', async () => {
    const deps = options()
    expect(
      await Promise.all([
        recoverFromVitePreloadError(preloadError(), deps),
        recoverFromVitePreloadError(preloadError(), deps),
      ]),
    ).toEqual([true, false])
    expect(deps.reload).toHaveBeenCalledOnce()
  })

  it('gives an expired guard and a new build a fresh budget', async () => {
    const deps = options()
    const recover = (build: string, now: number) =>
      recoverFromVitePreloadError(preloadError(), { ...deps, build, now })
    expect(await recover('https://podium.test/assets/app-a.js', 1_000)).toBe(true)
    expect(await recover('https://podium.test/assets/app-a.js', 1_001)).toBe(false)
    expect(await recover('https://podium.test/assets/app-b.js', 1_002)).toBe(true)
    expect(await recover('https://podium.test/assets/app-b.js', 5 * 60_000 + 1_003)).toBe(true)
    expect(deps.reload).toHaveBeenCalledTimes(3)
  })

  it.each([
    200, 403, 500,
  ])('does not reload for a response other than missing (%s)', async (status) => {
    const deps = { ...options(), probe: async () => ({ status }) }
    const event = preloadError()
    expect(await recoverFromVitePreloadError(event, deps)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('does not reload for a network error even if the device reports online', async () => {
    const deps = {
      ...options(),
      probe: vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    }
    const event = preloadError()
    expect(await recoverFromVitePreloadError(event, deps)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('rechecks connectivity after the missing-file probe', async () => {
    let online = true
    const deps = {
      ...options(),
      isOnline: () => online,
      probe: async () => {
        online = false
        return { status: 404 }
      },
    }
    const event = preloadError()
    expect(await recoverFromVitePreloadError(event, deps)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('leaves URL-less failures alone because they cannot prove a missing file', async () => {
    const deps = options()
    expect(
      await recoverFromVitePreloadError(preloadError('Importing a module script failed.'), deps),
    ).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('does not reload or cancel the rejection when storage is unavailable', async () => {
    const deps = {
      ...options(),
      storage: {
        getItem: () => {
          throw new Error('storage disabled')
        },
        setItem: vi.fn(),
      },
    }
    const event = preloadError()
    expect(await recoverFromVitePreloadError(event, deps)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('retries the failed import once on online, using a fresh native module URL', async () => {
    const target = new EventTarget()
    const error = preloadError().payload
    const load = vi.fn(async () => {
      throw error
    })
    const module = { default: 'screen' }
    const deps: ChunkRecoveryDeps = {
      askServer: async () => 'ok',
      wait: async () => {},
      now: () => 0,
      importUrl: vi.fn(async () => module),
    }
    const retries: Promise<unknown>[] = []
    const cancel = retryOnOnline(() => {
      retries.push(retryChunkImport(load, error, 1, deps))
    }, target)
    expect(load).not.toHaveBeenCalled()
    target.dispatchEvent(new Event('online'))
    target.dispatchEvent(new Event('online'))
    expect(await Promise.all(retries)).toEqual([module])
    expect(load).toHaveBeenCalledOnce()
    expect(deps.importUrl).toHaveBeenCalledWith('/assets/terminal.js?podium-retry=1')
    cancel()
  })

  it('removes an unmounted screen’s pending online retry', () => {
    const target = new EventTarget()
    const retry = vi.fn()
    retryOnOnline(retry, target)()
    target.dispatchEvent(new Event('online'))
    expect(retry).not.toHaveBeenCalled()
  })
})
