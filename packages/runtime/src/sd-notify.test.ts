import { describe, expect, it, vi } from 'vitest'
import { watchdogPetIntervalMs } from './sd-notify'

describe('watchdogPetIntervalMs', () => {
  it('pets at half the systemd WatchdogSec, converted from the WATCHDOG_USEC microseconds env', () => {
    // WatchdogSec=30 → systemd exports WATCHDOG_USEC=30000000 → pet every 15s.
    expect(watchdogPetIntervalMs('30000000')).toBe(15_000)
  })

  it('falls back to a default when WATCHDOG_USEC is unset (not under a Type=notify unit)', () => {
    // Passing `undefined` triggers the default parameter (process.env.WATCHDOG_USEC),
    // so stub the env: shells launched under Podium's own systemd units inherit a
    // real WATCHDOG_USEC=30000000 and this test would read the environment, not
    // the "unset" case it's about.
    vi.stubEnv('WATCHDOG_USEC', '')
    try {
      expect(watchdogPetIntervalMs(undefined, 12_000)).toBe(12_000)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('falls back when WATCHDOG_USEC is non-numeric or non-positive', () => {
    expect(watchdogPetIntervalMs('garbage', 9_000)).toBe(9_000)
    expect(watchdogPetIntervalMs('0', 9_000)).toBe(9_000)
  })

  it('never pets faster than once a second even with a tiny watchdog window', () => {
    expect(watchdogPetIntervalMs('200000' /* 0.2s → half is 0.1s */)).toBe(1_000)
  })
})
