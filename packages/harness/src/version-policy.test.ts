import { describe, expect, it } from 'vitest'
import {
  gateHarnessVersion,
  HARNESS_VERSION_POLICIES,
  harnessVersionFloor,
  parseHarnessVersion,
} from './version-policy'

describe('shared harness version policy', () => {
  it.each([
    ['codex', '0.146.99', '0.147.0', '0.151.0', '0.151.1'],
    ['opencode', '1.17.99', '1.18.0', '1.18.16', '1.18.17'],
    ['grok', '0.2.22', '0.2.23', '0.2.118', '0.2.119'],
  ] as const)('%s separates admission from fixture verification', (harness, old, floor, verified, newer) => {
    const policy = HARNESS_VERSION_POLICIES[harness]
    expect(gateHarnessVersion(policy, old)).toBe('too-old')
    expect(gateHarnessVersion(policy, floor)).toBe('verified')
    expect(gateHarnessVersion(policy, verified)).toBe('verified')
    expect(gateHarnessVersion(policy, newer)).toBe('unverified')
    expect(gateHarnessVersion(policy, '99.0.0')).toBe('unverified')
    expect(gateHarnessVersion(policy, '')).toBe('unparseable')
    expect(gateHarnessVersion(policy, 'changed banner')).toBe('unparseable')
  })

  it('supports an absent floor without imposing a ceiling', () => {
    const policy = { minimum: null, verifiedThrough: '1.0.0' }
    expect(harnessVersionFloor(policy)).toBe('*')
    expect(gateHarnessVersion(policy, '0.1.0')).toBe('verified')
    expect(gateHarnessVersion(policy, '2.0.0')).toBe('unverified')
  })

  it('parses banners and rejects partial or unsafe numeric versions', () => {
    expect(parseHarnessVersion('codex-cli v0.151.0-beta.1+build')).toMatchObject({
      major: 0,
      minor: 151,
      patch: 0,
    })
    expect(parseHarnessVersion('0.151')).toBeNull()
    expect(parseHarnessVersion('999999999999999999999.1.0')).toBeNull()
  })
})
