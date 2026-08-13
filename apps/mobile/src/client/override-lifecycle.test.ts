import { describe, expect, it, vi } from 'vitest'
import { clearLocalCredentialSurfaces, preflightNativeOverride } from './override-lifecycle'

describe('native override credential lifecycle', () => {
  it('clears every local bearer surface in order without a network capability', () => {
    const events: string[] = []

    clearLocalCredentialSurfaces({
      clearHttpRuntime: () => events.push('http'),
      clearWebSocket: () => events.push('websocket'),
      clearBearer: () => events.push('bearer'),
      markCredentialUnreleased: () => events.push('unreleased'),
    })

    expect(events).toEqual(['http', 'websocket', 'bearer', 'unreleased'])
  })

  it('clears before validation and again when identity preflight fails', async () => {
    const events: string[] = []
    const fetchLikePreflight = vi.fn(async () => {
      events.push('preflight')
      return { ok: false as const }
    })

    await expect(
      preflightNativeOverride({
        clearLocalCredentials: () => events.push('clear'),
        preflight: fetchLikePreflight,
      }),
    ).resolves.toEqual({ ok: false })

    expect(events).toEqual(['clear', 'preflight', 'clear'])
    expect(fetchLikePreflight).toHaveBeenCalledOnce()
  })

  it('clears again when preflight throws and never performs a logout request', async () => {
    const events: string[] = []
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      preflightNativeOverride({
        clearLocalCredentials: () => events.push('clear'),
        preflight: async () => {
          events.push('preflight')
          throw new Error('identity unavailable')
        },
      }),
    ).rejects.toThrow('identity unavailable')

    expect(events).toEqual(['clear', 'preflight', 'clear'])
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
