/**
 * POD-4565 (Ma1) — the enforcement ASSERTION for the pool's tests: MobX's
 * enforcement flags only warn (`enforce.ts`), so every pool test installs this
 * trap, which turns any `console.warn` into a thrown error and records it; the
 * test then fails on any recorded warning, including one MobX swallowed inside
 * a reaction. `pool.test.tsx` proves the trap fires on an untracked read.
 */

import { afterEach, beforeEach, expect, vi } from 'vitest'

export function installMobxWarnTrap(): { readonly warnings: string[] } {
  const state = { warnings: [] as string[] }
  beforeEach(() => {
    state.warnings.length = 0
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const message = args.map(String).join(' ')
      state.warnings.push(message)
      throw new Error(`console.warn (trapped): ${message}`)
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    expect(state.warnings, 'MobX (or React) warned during the test').toEqual([])
  })
  return state
}
