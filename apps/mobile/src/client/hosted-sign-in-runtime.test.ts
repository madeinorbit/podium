import { describe, expect, it, vi } from 'vitest'
const seams = vi.hoisted(() => ({
  deps: null as unknown,
  create: vi.fn((deps: unknown) => {
    seams.deps = deps
    return {}
  }),
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  open: vi.fn(),
  fetch: vi.fn(),
  digest: vi.fn(),
}))
vi.mock('./hosted-sign-in', () => ({ createHostedSignIn: seams.create }))
vi.mock('expo/fetch', () => ({ fetch: seams.fetch }))
vi.mock('expo-crypto', () => ({
  digestStringAsync: seams.digest,
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}))
vi.mock('expo-secure-store', () => ({
  getItemAsync: seams.get,
  setItemAsync: seams.set,
  deleteItemAsync: seams.remove,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only',
}))
vi.mock('react-native', () => ({ Linking: { openURL: seams.open } }))
import './hosted-sign-in-runtime.native'
describe('native hosted sign-in adapters', () => {
  it('keeps the pending verifier in device-only secure storage and opens the OS browser', async () => {
    const deps = seams.deps as import('./hosted-sign-in').HostedSignInDependencies
    await deps.write('proof')
    await deps.read()
    await deps.remove()
    await deps.open('https://ade.podium.do')
    await deps.digest('proof')
    expect(seams.set).toHaveBeenCalledWith('podium.mobile.hosted-sign-in.v1', 'proof', {
      keychainAccessible: 'device-only',
    })
    expect(seams.get).toHaveBeenCalledWith('podium.mobile.hosted-sign-in.v1')
    expect(seams.remove).toHaveBeenCalledWith('podium.mobile.hosted-sign-in.v1')
    expect(seams.open).toHaveBeenCalledWith('https://ade.podium.do')
    expect(deps.fetch).toBe(seams.fetch)
    expect(seams.digest).toHaveBeenCalledWith('SHA-256', 'proof')
  })
})
