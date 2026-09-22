/**
 * POD-4565 (Ma1) — MobX enforcement for the round-three pool, configured
 * here and ASSERTED by the tests (`pool.test.tsx` installs a `console.warn`
 * trap that throws and fails on any recorded MobX warning).
 *
 * - `enforceActions: 'always'`: every write is inside `runInAction` (one per
 *   `RowSourceEvent`, one per locals notification).
 * - `computedRequiresReaction` / `observableRequiresReaction`: a read outside
 *   a reaction or an action warns. The pool's own out-of-reaction reader
 *   (`snapshot()`) reads inside a transient reaction (`tracked` in
 *   `pool.ts`), so a warning always means a real untracked read.
 * - `reactionRequiresObservable`: a reaction that observes nothing warns.
 *
 * The round-two arm's `../config.ts` sets the same four flags; MobX
 * configuration is process-global, so the two agree by construction.
 * No `keepAlive` anywhere in `pool/`.
 */

import { configure } from 'mobx'

export const ENFORCEMENT = {
  enforceActions: 'always',
  computedRequiresReaction: true,
  observableRequiresReaction: true,
  reactionRequiresObservable: true,
} as const

configure(ENFORCEMENT)
