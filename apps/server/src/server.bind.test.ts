import { describe, expect, test } from 'vitest'
import { isLoopbackHost, resolveBindHost } from './server'

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
