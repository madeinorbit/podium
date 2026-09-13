/**
 * THE JOIN (PDM-308) — the two layout write contracts (L1) paired with the
 * service calls that implement them (L3), per ADR 3 D1, and the one read that is
 * deliberately not a contract.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG, AND WHY IT LOOKED SAFER THAN `operations` DID
 * ---------------------------------------------------------------------------
 *
 * `modules/layout/trpc.ts` hand-wrote three procedures. It DID import the
 * contracts — for `.name` and `.input` — and `modules/layout/authz.ts` imports
 * `LAYOUT_CONTRACTS` and reads `.policy` off them to enforce the declared floor
 * live. So a reader who opened either file saw contracts being consulted and
 * stopped asking.
 *
 * NEITHER FILE EVER READ `.exposure`. `grep -n exposure` over the whole module
 * directory returned nothing. The POLICY half of the contract was attached and
 * the EXPOSURE half was not, which is worse than `operations` was: there,
 * nothing was attached and the gap was at least uniform. A mechanism's
 * completeness over ONE axis says nothing about the others, and the more
 * thorough it looks the less anyone thinks to ask.
 *
 * ---------------------------------------------------------------------------
 * MEASURED BEFORE IT WAS FIXED
 * ---------------------------------------------------------------------------
 *
 * Two plants, against a green baseline of the same eleven files:
 *
 *   A. `exposure: ['mcp']` on `layout.set` — the contract saying "NOT served on
 *      tRPC" while `router.ts` served it on tRPC. The server side stayed
 *      ENTIRELY green (`services` 28/28, `store` 8/8, both exit 0). The only
 *      red anywhere was `packages/commands/src/layout/contracts.test.ts`'s
 *      "both writes are per-user-state, offline-eligible, and on the outbox",
 *      which RESTATES the expected tags by hand and never consults a router.
 *      `readPosition.advance` under the same plant reddened NOTHING AT ALL,
 *      because its family has no contracts test.
 *
 *   B. `exposure: ['trpc', 'outbox', 'mcp']` — declaring a transport the command
 *      is NOT served on, which is the direction a restating `toContain`
 *      assertion cannot see. EVERYTHING passed, including the one test that
 *      caught plant A.
 *
 * So the contract could name any transport set it liked, in either direction,
 * and the procedures kept serving. That is the defect demonstrated rather than
 * argued, and it is why this is a row and not a footnote: every exposure
 * instrument the epic has — the totality tests, the census, the
 * deferred-capability mechanism — is defined over contracts JOINED to their
 * procedures, so an unjoined contract is not merely unenforced, it is UNSEEN,
 * and all of them report green about a surface they cannot see.
 *
 * WHAT ACTUALLY CATCHES THE PLANT NOW, STATED PRECISELY, because the obvious
 * sentence to write here is wrong and this issue checked it.
 *
 * Plant A now reddens: `readPosition`/`layout` serve NOTHING once the contract
 * names a transport other than tRPC, and `derived-family.runtime.test.ts` fails
 * by name — "expected [] to deeply equal [ 'advance' ]" — because it compares
 * the RUNNING `appRouter` against the family's own table. That is the join doing
 * its job: the declaration is now load-bearing, where before it was inert.
 *
 * It does NOT fail at module load, and `assertSurfaceMatchesDeclarations` is not
 * what catches it. That function's two membership arms are STRUCTURALLY UNABLE
 * TO FIRE: `built[name]` is assigned if and only if
 * `command.contract.exposure.includes('trpc')`, and `declared` re-evaluates that
 * identical expression on the same object, so `declared === present` for every
 * name and neither `throw` is reachable. Filed as a finding rather than repaired
 * here — it is a property of the shared builder and of all sixteen families, not
 * of this one.
 *
 * Plant B — a transport DECLARED but not served, `['trpc', 'outbox', 'mcp']` —
 * still passes after this join, and that is the honest boundary of it. The
 * builder compares one axis, `trpc`. Nothing anywhere compares a family's
 * declared `mcp` or `outbox` exposure against a surface that serves it.
 *
 * So what this table buys is the tRPC axis, in both directions, enforced by the
 * compiler (`satisfies` below) and by a running-object assertion — and not one
 * sentence more than that.
 *
 * ---------------------------------------------------------------------------
 * WHY THE READ IS NOT A CONTRACT, AND WHY IT IS GATED ANYWAY
 * ---------------------------------------------------------------------------
 *
 * `get` is a `DerivedQuery`, not a `CommandContract`, for the reason
 * `workflows/queries.ts` gives: a `visibility` class describes what a command
 * WRITES, and a read writes nothing. It is declared here with its transport so
 * the same both-directions check covers it — a read that stopped being served
 * fails exactly as a write would.
 *
 * It still runs the gate, keyed by `layout.set`'s name, because that is what
 * the hand-written router did and because a layout snapshot is per-user state:
 * "who may see it" and "who may move it" are one question, and the snapshot
 * returned is always the ACTOR's. There is no argument by which a caller could
 * ask for someone else's.
 */

import {
  type LayoutContractName,
  layoutClearContract,
  layoutSetContract,
  type TransportTag,
} from '@podium/commands'
import { z } from 'zod'
import type { RegistryModules } from '../../relay'
import type { DerivedCommand, DerivedQuery } from '../derived-family'
import type { PerUserActorGate } from '../per-user-actor-gate'

/**
 * Exactly what the layout family reaches, named.
 *
 * `actors` is the pre-bound gate, NOT a principal: a handler asks it whose row
 * it may write and is handed a `UserId` or a refusal. See
 * `../per-user-actor-gate.ts` for why the gate survived the move to the builder
 * rather than folding into the contract's declared floor.
 */
export interface LayoutState {
  readonly layout: RegistryModules['layout']
  readonly actors: PerUserActorGate
}

export type LayoutCommand = DerivedCommand<LayoutState>

/**
 * THE PROCEDURE NAMES, DERIVED FROM THE CONTRACT NAMES RATHER THAN RETYPED.
 *
 * `LAYOUT_CONTRACTS` is keyed by QUALIFIED name (`layout.set`) while the router
 * key is the bare verb (`set`), so the totality constraint below cannot use
 * `LayoutContractName` directly the way `operations` could — its contracts are
 * keyed bare. Stripping the prefix in the type keeps the join checked in BOTH
 * directions anyway: a contract with no entry fails to satisfy the `Record`, and
 * an entry naming a verb no contract declares fails as an excess property.
 */
type LayoutProcedureName = LayoutContractName extends `layout.${infer Verb}` ? Verb : never

const nowIso = (): string => new Date().toISOString()

/**
 * THE TABLE. A third layout command cannot be served without a contract, and a
 * contract cannot be retired while a handler still implements it.
 */
export const LAYOUT_COMMANDS_TRPC = {
  set: {
    contract: layoutSetContract,
    handler: (async (state, input) => {
      const actor = await state.actors.requireActor(layoutSetContract.name)
      return await state.layout.set(actor, input.values, nowIso())
    }) satisfies LayoutCommand['handler'],
  },
  clear: {
    contract: layoutClearContract,
    handler: (async (state, input) => {
      const actor = await state.actors.requireActor(layoutClearContract.name)
      return await state.layout.clear(actor, input.keys)
    }) satisfies LayoutCommand['handler'],
  },
} as const satisfies Record<LayoutProcedureName, LayoutCommand>

export type LayoutCommandName = keyof typeof LAYOUT_COMMANDS_TRPC

/** The one read. Declared with its transport so the builder's both-directions
 *  check covers it alongside the writes. */
export const LAYOUT_QUERIES = {
  get: {
    input: z.void(),
    exposure: ['trpc'] as readonly TransportTag[],
    run: async (state: LayoutState) => {
      // Gated on the WRITE contract's name, which is what the hand-written
      // router did: a layout snapshot is per-user state, so "who may read it"
      // and "who may write it" are the same question.
      const actor = await state.actors.requireActor(layoutSetContract.name)
      return await state.layout.getSnapshot(actor)
    },
  },
} as const satisfies Record<string, DerivedQuery<LayoutState>>

/** Bundle used by `layoutFamilyProcedures` — keeps the selector in one place. */
export function selectLayoutState(
  modules: RegistryModules,
  actors: PerUserActorGate,
): LayoutState {
  return { layout: modules.layout, actors }
}
