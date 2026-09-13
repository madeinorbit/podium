/**
 * THE LAYOUT SURFACE (POD-1350), DERIVED (PDM-308).
 *
 * Three procedures — `get`, `set`, `clear` — and until this issue all three were
 * HAND-WRITTEN here. This file imported the contracts, and `./authz` imports
 * them too and reads `.policy` off them, so the family LOOKED joined. Neither
 * file ever read `.exposure`: the policy half was attached and the exposure half
 * was not, and nothing compared what the contracts declared about transports
 * with what `router.ts` served.
 *
 * Measured, not assumed. Planting `exposure: ['mcp']` on `layout.set` while this
 * router served it on tRPC left the whole server side green; the only red
 * anywhere was a hand-written restatement in `packages/commands`. Planting the
 * opposite mismatch — a transport DECLARED but not served — reddened nothing at
 * all, including that test. See `./registry`'s header for the numbers.
 *
 * The procedures now come off `LAYOUT_COMMANDS_TRPC` and `LAYOUT_QUERIES` in
 * `./registry`, through the one derived builder, so a contract that names a
 * transport other than tRPC now REMOVES the procedure, and the running-object
 * assertion in `../derived-family.runtime.test.ts` fails by name when the table
 * and the router disagree. See `./registry`'s header for what that does and does
 * not cover — the module-load check is NOT what catches it. This file declares
 * only what differs: which tables, which state.
 *
 * WHAT DID NOT MOVE, AND WHY THAT IS THE INTERESTING HALF. `./authz` is still
 * here and still runs. `PDM-297` folded `operations`' hard-coded `admin`
 * comparison into the floor the builder now enforces, and the same move here
 * would have been a REGRESSION: all three layout contracts declare
 * `roleFloor: 'member'`, and the builder deliberately does not gate the `member`
 * floor (`role-floor.ts`, point 1). This family's gate refuses an ABSENT role at
 * that floor — a disabled account that still resolves to a human — which is
 * POD-402 review gap 1 and is pinned by `authz.test.ts`. So the gate is
 * pre-bound as a port instead; `../per-user-actor-gate.ts` carries the argument.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { LAYOUT_COMMANDS_TRPC, LAYOUT_QUERIES, selectLayoutState } from './registry'

export type LayoutProcedures = FamilyProcedures<
  typeof LAYOUT_COMMANDS_TRPC,
  typeof LAYOUT_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `layout` router. */
export const layoutFamilyProcedures = (): LayoutProcedures =>
  derivedFamilyProcedures({
    family: 'layout',
    service: (state) => selectLayoutState(state.modules, state.layoutActors),
    commands: LAYOUT_COMMANDS_TRPC,
    queries: LAYOUT_QUERIES,
  })
