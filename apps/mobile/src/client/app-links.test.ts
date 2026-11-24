import { beforeEach, describe, expect, it, vi } from 'vitest'

const seams = vi.hoisted(() => ({
  rnInitial: vi.fn<() => Promise<string | null>>(),
  rnListener: null as ((event: { url: string }) => void) | null,
  expoListener: null as ((event: { url: string }) => void) | null,
  expoLinking: null as null | {
    getLinkingURL: ReturnType<typeof vi.fn>
    clearInitialURL: ReturnType<typeof vi.fn>
    addListener: ReturnType<typeof vi.fn>
  },
}))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: {
    getInitialURL: seams.rnInitial,
    addEventListener: (_event: string, listener: (event: { url: string }) => void) => {
      seams.rnListener = listener
      return { remove: () => (seams.rnListener = null) }
    },
  },
}))
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => seams.expoLinking,
}))

const { clearInitialAppUrl, readInitialAppUrl, subscribeAppUrls } = await import('./app-links')

beforeEach(() => {
  seams.rnInitial.mockReset()
  seams.rnListener = null
  seams.expoListener = null
  seams.expoLinking = {
    getLinkingURL: vi.fn(() => null),
    clearInitialURL: vi.fn(),
    addListener: vi.fn((_event: string, listener: (event: { url: string }) => void) => {
      seams.expoListener = listener
      return { remove: () => (seams.expoListener = null) }
    }),
  }
})

describe('app link delivery', () => {
  it('reads the cold launch URL from expo-linking when React Native has none', async () => {
    // The UIScene re-feed fills expo-linking's registry but not React Native's
    // launch options: the cold pairing link used to reach only the router.
    seams.rnInitial.mockResolvedValue(null)
    seams.expoLinking?.getLinkingURL.mockReturnValue('podium:///pair?url=x')
    await expect(readInitialAppUrl()).resolves.toBe('podium:///pair?url=x')
  })

  it('prefers React Native when it has the launch URL', async () => {
    seams.rnInitial.mockResolvedValue('podium://pair?url=rn')
    seams.expoLinking?.getLinkingURL.mockReturnValue('podium://pair?url=expo')
    await expect(readInitialAppUrl()).resolves.toBe('podium://pair?url=rn')
  })

  it('survives a missing native module', async () => {
    seams.expoLinking = null
    seams.rnInitial.mockResolvedValue(null)
    await expect(readInitialAppUrl()).resolves.toBeNull()
    expect(() => clearInitialAppUrl()).not.toThrow()
    const listener = vi.fn()
    subscribeAppUrls(listener)
    seams.rnListener?.({ url: 'podium://pair?url=a' })
    expect(listener).toHaveBeenCalledWith('podium://pair?url=a')
  })

  it('delivers a warm link that only expo-linking receives', () => {
    const listener = vi.fn()
    subscribeAppUrls(listener)
    seams.expoListener?.({ url: 'podium://pair?url=warm' })
    expect(listener).toHaveBeenCalledExactlyOnceWith('podium://pair?url=warm')
  })

  it('reports one open once when both channels deliver it, and a later reopen again', () => {
    let now = 1_000
    const listener = vi.fn()
    const subscription = subscribeAppUrls(listener, () => now)
    seams.expoListener?.({ url: 'podium://pair?url=a' })
    seams.rnListener?.({ url: 'podium://pair?url=a' })
    expect(listener).toHaveBeenCalledTimes(1)
    seams.rnListener?.({ url: 'podium://pair?url=b' })
    expect(listener).toHaveBeenCalledTimes(2)
    now += 5_000
    seams.expoListener?.({ url: 'podium://pair?url=b' })
    expect(listener).toHaveBeenCalledTimes(3)
    subscription.remove()
    expect(seams.rnListener).toBeNull()
    expect(seams.expoListener).toBeNull()
  })
})
