import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('bounded cached-interface recovery', () => {
  it('loads server HTML even when registration lookup stalls, ignoring its late answer', async () => {
    const { forceReload, CACHE_RESET_BUDGET_MS } = await import('./force-reload')
    let release!: (registrations: { unregister: () => Promise<boolean> }[]) => void
    const unregister = vi.fn(async () => true)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: () =>
          new Promise((resolve) => {
            release = resolve
          }),
      },
    })
    const replace = vi.fn()
    vi.stubGlobal('window', {
      location: { protocol: 'https:', href: 'https://podium.test/workspace?pane=unsent', replace },
    })
    await vi.advanceTimersByTimeAsync(0)
    const attempt = forceReload('test', false)
    await vi.advanceTimersByTimeAsync(CACHE_RESET_BUDGET_MS)
    await attempt
    expect(replace).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('https://podium.test/?'))
    release([{ unregister }])
    await Promise.resolve()
    expect(unregister).not.toHaveBeenCalled()
  })

  it('keeps outbox and draft storage, recapturing drafts after unregister', async () => {
    const { forceReload } = await import('./force-reload')
    const { registerReloadPreparation } = await import('./reload-preparation')
    const order: string[] = []
    registerReloadPreparation(async () => {
      order.push('save')
    })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: async () => [
          {
            unregister: async () => {
              order.push('unregister')
              return true
            },
          },
        ],
      },
    })
    const clear = vi.fn()
    vi.stubGlobal('caches', { keys: clear, delete: clear })
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        href: 'https://podium.test/workspace',
        replace: () => order.push('navigate'),
      },
    })
    await forceReload('test', false)
    expect(order).toEqual(['save', 'unregister', 'save', 'navigate'])
    expect(clear).not.toHaveBeenCalled()
  })
})
