/**
 * POD-4447 — MobX enforcement. One `configure` call for the arm, imported by
 * `arm.ts` so every entry (web, native, tests) runs enforced.
 *
 * - `enforceActions: 'always'` — all writes inside `runInAction` (one per
 *   `RowSourceEvent`, plus `setSelection` / `setCoarseNow` for locals).
 * - `computedRequiresReaction` — warns when a computed is read outside a
 *   reaction. Arm `snapshot()` reads outside reactions by contract (it is the
 *   harness's read API); those warnings are expected, never a failure.
 * - `observableRequiresReaction` — warns on untracked staging reads outside
 *   reactions (the K2 foot-gun: plain values read outside `observer`).
 * - `reactionRequiresObservable` — warns on reactions that observe nothing.
 *
 * No `keepAlive` anywhere in this folder: computeds suspend when unobserved
 * and that is correct (methodology §5.3; MobX `computeds.html` "suspension").
 */

import { configure } from 'mobx'

configure({
  enforceActions: 'always',
  computedRequiresReaction: true,
  observableRequiresReaction: true,
  reactionRequiresObservable: true,
})
