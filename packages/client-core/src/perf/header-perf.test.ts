import { afterEach, describe, expect, it } from 'vitest'
import { headerStats, measureHeader, measureLegacyHeader } from './header-perf'
import { storeStats } from './store-stats'

afterEach(() => { headerStats.disable(); headerStats.reset(); storeStats.disable(); storeStats.reset() })
describe('header derivation counters', () => {
  it('counts the actual legacy derivation in the store and preserves its result and error', () => {
    const owner = {}
    storeStats.enable(); headerStats.enable()
    expect(measureLegacyHeader(owner, 'working', () => 42)).toBe(42)
    expect(() => measureLegacyHeader(owner, 'working', () => { throw new Error('synthetic') })).toThrow('synthetic')
    expect(storeStats.snapshot().runtimes[0]?.slices['header.working']).toBe(2)
    expect(headerStats.read()['legacy.working']?.calls).toBe(2)
  })
  it('retains no payloads, bounds names, and does no counting while disabled', () => {
    measureHeader('disabled', () => ({ title: 'synthetic private value' }))
    expect(headerStats.read()).toEqual({})
    headerStats.enable()
    for (let i = 0; i < 100; i++) measureHeader(`${i}-${'x'.repeat(100)}`, () => ({ title: 'synthetic private value' }))
    const values = headerStats.read()
    expect(Object.keys(values)).toHaveLength(64)
    expect(Object.keys(values).every((name) => name.length <= 80)).toBe(true)
    expect(JSON.stringify(values)).not.toContain('synthetic private value')
  })
})
