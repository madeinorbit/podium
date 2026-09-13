/**
 * THE OPERATION SURFACE (POD-2097, spec §3.0/§3.7), DERIVED (PDM-297).
 *
 * Five procedures — `active`, `history`, `cancel`, `settleAsk`, `action` — and
 * until this issue all five were HAND-WRITTEN here, joined to nothing. This file
 * imported no contract, there was no `OPERATION_COMMANDS_TRPC` anywhere in
 * `apps/server`, and so the three contracts in `packages/commands/src/operations`
 * that declared a policy and a transport were not merely unenforced: they were
 * UNATTACHED. Nothing compared what they declared with what was served.
 *
 * That is a worse failure than an unenforced floor and it is why it was its own
 * row. Every instrument this epic relies on for exposure — the totality tests,
 * the census, the deferred-capability mechanism — is defined over contracts
 * JOINED to their procedures. An unjoined contract is invisible to all of them,
 * so they answer green about a surface they cannot see. Measured, not assumed:
 * planting `exposure: ['mcp']` on `operations.cancel` while this router served it
 * on tRPC reddened NOTHING in either package.
 *
 * The procedures now come off `OPERATION_COMMANDS_TRPC` and `OPERATION_QUERIES`
 * in `./registry`, through the one derived builder, so the same plant now fails
 * at module load by name. This file declares only what differs: which tables,
 * which state.
 *
 * WHAT LEFT THIS FILE AND WHERE IT WENT, since neither is a deletion:
 *
 *   - the hard-coded `admin` comparison in `assertActionAuthorized` is GONE,
 *     replaced by the floor the three contracts already declared. `PDM-294` made
 *     the builder read `contract.policy.roleFloor` and refuse below it at the
 *     transport; `PDM-299` rewired this file's copy onto the one shared decision
 *     and said in as many words that `PDM-297` owns the follow-through — "this
 *     whole function becomes `roleFloorFailure(qualifiedName, contract, deps)`
 *     and the hard-coded floor goes with it". It does. The rule is unchanged:
 *     both spellings resolved the account grade through `roleFloorDeps` and
 *     decided with `adminFloorRefusal`.
 *   - the target-machine `manage` check moved to `./operation-target-gate`,
 *     because a floor is a claim about the CALLER and that one is about the
 *     TARGET. See that file's header, and the third position in
 *     `derived-family.ts`'s "THE DECISIONS THIS FILE DOES TAKE".
 *
 * `active` STILL SERVES THE STORED BYTES. That was this file's loudest claim and
 * the derivation does not weaken it: the read is a `DerivedQuery` whose `run`
 * hands back what the engine projected, and `history` still hands on the parsed
 * payload. The frozen contract (P8) is that a server must be able to hand an old
 * bundle a field that bundle has never heard of — and the web bundle is swapped
 * during the very operation it is rendering, so anything re-shaped on the way
 * out would be a second definition of the contract in the one place the two ends
 * are guaranteed to be different builds.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import {
  OPERATION_COMMANDS_TRPC,
  OPERATION_QUERIES,
  selectOperationState,
} from './registry'

export type OperationProcedures = FamilyProcedures<
  typeof OPERATION_COMMANDS_TRPC,
  typeof OPERATION_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `operations` router. */
export const operationProcedures = (): OperationProcedures =>
  derivedFamilyProcedures({
    family: 'operations',
    service: (state) => selectOperationState(state.modules, state.operationTargets),
    commands: OPERATION_COMMANDS_TRPC,
    queries: OPERATION_QUERIES,
  })
