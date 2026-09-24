/**
 * POD-4565 (Ma1) — the enforcement ASSERTION for the pool's tests: MobX's
 * enforcement flags only warn (`enforce.ts`), so every pool test installs this
 * trap, which turns any `console.warn` into a thrown error and records it; the
 * test then fails on any recorded warning, including one MobX swallowed inside
 * a reaction. `pool.test.tsx` proves the trap fires on an untracked read.
 *
 * `{ errors: true }` (POD-4572, M3 note N3): a throw inside a reaction never
 * reaches the test; MobX catches it and reports it through `console.error`.
 * With `errors` the trap records every `console.error` too (recorded, never
 * rethrown: MobX calls it from inside its reaction loop), and the test fails
 * on any. The native lane installs it this way and proves it armed with a
 * planted warning and a planted reaction error (`mobx-pool.native.test.tsx`).
 */

import { afterEach, beforeEach, expect, vi } from 'vitest'

export interface MobxTrapState {
  readonly warnings: string[]
  /** `console.error` calls, when installed with `errors`. */
  readonly errors: string[]
}

export function installMobxWarnTrap(options: { errors?: boolean } = {}): MobxTrapState {
  const state: MobxTrapState = { warnings: [], errors: [] }
  beforeEach(() => {
    state.warnings.length = 0
    state.errors.length = 0
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const message = args.map(String).join(' ')
      state.warnings.push(message)
      throw new Error(`console.warn (trapped): ${message}`)
    })
    if (options.errors === true) {
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        state.errors.push(args.map(String).join(' '))
      })
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    expect(state.warnings, 'MobX (or React) warned during the test').toEqual([])
    expect(state.errors, 'MobX (or React) reported an error during the test').toEqual([])
  })
  return state
}
