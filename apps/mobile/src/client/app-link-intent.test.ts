import { formatPodiumLink, PODIUM_SCHEME } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { isGateOwnedAppLink, nativeMissionHref, redirectSystemPath } from './app-link-intent'

describe('gate-owned app links', () => {
  it('keeps pairing and sign-in links away from the router in every iOS spelling', () => {
    for (const link of [
      'podium:///signed-in?code=abc&challenge=def',
      'podium://pair?url=https%3A%2F%2Fpodium.example%2Fmobile%23pair%3Dsecret',
      'podium:///pair?url=https%3A%2F%2Fpodium.example%2Fmobile%23pair%3Dsecret',
      'podium://pair/eyJ2IjoyfQ',
      'PODIUM://Pair/eyJ2IjoyfQ',
      'podium://signed-in?code=abc&challenge=def',
    ]) {
      expect(isGateOwnedAppLink(link)).toBe(true)
      expect(redirectSystemPath({ path: link, initial: true })).toBe('/')
      // A running app moves nowhere: a root navigation would remount the gate
      // and drop the pairing envelope or hosted return it holds (POD-6913).
      expect(redirectSystemPath({ path: link, initial: false })).toBeNull()
    }
  })

  it('leaves native handoffs to the authenticated host and gives cold launches a tab root', () => {
    for (const link of [
      'podium://issue/iss_one',
      'podium:///issue/iss_one',
      'podium://issues/POD-1',
      'podium://session/abc',
      'podium://sessions/abc',
      'podium://session/abc/terminal',
      'podium:///session/abc/terminal',
      formatPodiumLink(PODIUM_SCHEME, {
        kind: 'session',
        session: 'notification-session',
        search: '?origin=https%3A%2F%2Fpodium.example&instance=instance-one',
      }),
    ]) {
      expect(isGateOwnedAppLink(link)).toBe(false)
      expect(redirectSystemPath({ path: link, initial: true })).toBe('/work')
      expect(redirectSystemPath({ path: link, initial: false })).toBeNull()
    }
    expect(isGateOwnedAppLink('podium://pairing-help')).toBe(false)
  })

  it('leaves non-native routes unchanged', () => {
    for (const path of ['/issues/POD-1', 'https://podium.example/issues/POD-1', '/work']) {
      expect(redirectSystemPath({ path, initial: false })).toBe(path)
    }
  })
})

describe('native mission URL to route mapping', () => {
  it.each([
    ['podium://mission/root', '/mission/root'],
    ['podium://mission/root/lead', '/mission/root?sessionId=lead'],
    ['podium:///mission/root/lead', '/mission/root?sessionId=lead'],
    ['PoDiUm://mission/root/lead', '/mission/root?sessionId=lead'],
    ['podium://mission/root?sessionId=lead', '/mission/root?sessionId=lead'],
    ['podium://mission/root/details', '/mission/root/details'],
    ['podium://mission/root/details?sessionId=lead', '/mission/root/details?sessionId=lead'],
    ['podium://mission/task%2Fone/seat%2Ftwo', '/mission/task%2Fone?sessionId=seat%2Ftwo'],
    [
      'podium://mission/task%20one?sessionId=seat%2Btwo',
      '/mission/task%20one?sessionId=seat%2Btwo',
    ],
    ['/mission/root/lead', '/mission/root?sessionId=lead'],
  ])('%s opens %s on cold and warm delivery', (path, href) => {
    expect(nativeMissionHref(path)).toBe(href)
    for (const initial of [true, false]) {
      expect(redirectSystemPath({ path, initial })).toBe(href)
    }
  })

  it.each([
    'podium://mission',
    'podium://mission/root/lead/extra',
    'podium://mission/%ZZ/lead',
    'podium://mission/root?sessionId=',
    'podium://mission/root?sessionId=one&sessionId=two',
    'podium://mission/root?origin=https%3A%2F%2Fother.example',
    'podium://mission/root#unhandled',
    'podium://user:secret@mission/root/lead',
    'https://mission/root/lead',
  ])('does not map an unsupported mission address: %s', (path) => {
    expect(nativeMissionHref(path)).toBeNull()
  })
})
