import { describe, expect, it } from 'vitest'
import { isGateOwnedAppLink, redirectSystemPath } from './app-link-intent'

describe('gate-owned app links', () => {
  it('keeps pairing and sign-in links away from the router in every iOS spelling', () => {
    for (const link of [
      'podium://pair?url=https%3A%2F%2Fpodium.example%2Fmobile%23pair%3Dsecret',
      'podium:///pair?url=https%3A%2F%2Fpodium.example%2Fmobile%23pair%3Dsecret',
      'podium://pair/eyJ2IjoyfQ',
      'PODIUM://Pair/eyJ2IjoyfQ',
      'podium://signed-in?code=abc&challenge=def',
    ]) {
      expect(isGateOwnedAppLink(link)).toBe(true)
      expect(redirectSystemPath({ path: link, initial: true })).toBe('/')
    }
  })

  it('passes navigation links through unchanged', () => {
    for (const link of ['podium://issues/POD-1', 'podium://sessions/abc', '/issues/POD-1']) {
      expect(isGateOwnedAppLink(link)).toBe(false)
      expect(redirectSystemPath({ path: link, initial: false })).toBe(link)
    }
    expect(isGateOwnedAppLink('podium://pairing-help')).toBe(false)
  })
})
