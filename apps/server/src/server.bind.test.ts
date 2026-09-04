import { describe, expect, test } from 'vitest'
import {
  isLoopbackHost,
  resolveBindHost,
  resolveTrustedProxyHops,
  shouldAdvertiseLocalSetupDefault,
} from './server'

describe('resolveBindHost', () => {
  test('defaults to loopback (127.0.0.1) when nothing is configured', () => {
    expect(resolveBindHost({}, {})).toBe('127.0.0.1')
  })

  test('an explicit opts.host wins over the env', () => {
    expect(resolveBindHost({ host: '0.0.0.0' }, { PODIUM_HOST: '10.0.0.5' })).toBe('0.0.0.0')
  })

  test('PODIUM_HOST is honored when no explicit host is given', () => {
    expect(resolveBindHost({}, { PODIUM_HOST: '0.0.0.0' })).toBe('0.0.0.0')
  })
})

describe('isLoopbackHost', () => {
  test('loopback addresses are recognized', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
  })

  test('all-interfaces and routable addresses are not loopback', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('::')).toBe(false)
    expect(isLoopbackHost('10.0.0.5')).toBe(false)
    expect(isLoopbackHost('podium.example.com')).toBe(false)
  })
})

describe('resolveTrustedProxyHops', () => {
  test('trusts one local hop when the server itself is loopback-only', () => {
    expect(resolveTrustedProxyHops(undefined, {}, '127.0.0.1')).toBe(1)
    expect(resolveTrustedProxyHops(undefined, {}, 'localhost')).toBe(1)
  })

  test('does not infer proxy trust on a network bind or over explicit configuration', () => {
    expect(resolveTrustedProxyHops(undefined, {}, '0.0.0.0')).toBe(0)
    expect(
      resolveTrustedProxyHops(undefined, { PODIUM_TRUSTED_PROXY_HOPS: '2' }, '127.0.0.1'),
    ).toBe(2)
    expect(resolveTrustedProxyHops(0, {}, '127.0.0.1')).toBe(0)
  })
})

describe('shouldAdvertiseLocalSetupDefault', () => {
  test('requires an opted-in launcher on a loopback bind', () => {
    expect(shouldAdvertiseLocalSetupDefault({ localSetupDefault: true }, {})).toBe(true)
    expect(shouldAdvertiseLocalSetupDefault({}, {})).toBe(false)
  })

  test('retains advanced authenticated setup when the server is reachable off-box', () => {
    expect(
      shouldAdvertiseLocalSetupDefault({ localSetupDefault: true }, { PODIUM_HOST: '0.0.0.0' }),
    ).toBe(false)
  })
})
