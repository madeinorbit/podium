/**
 * THE DERIVED SPEC SURFACE (POD-386, the 3.3d cutover) — `specs.create`,
 * `specs.save` and `specs.remove`, produced from the joined table in
 * `registry.ts` rather than written out in `router.ts`.
 *
 * ---------------------------------------------------------------------------
 * ON THE PLAIN COMMAND PATH (POD-6418, ADR 12 O1 and D8)
 * ---------------------------------------------------------------------------
 *
 * A spec is a file in the repository: git is its truth, and nothing of it is
 * synced (ADR 12 D1 places specs among the request answers). So a spec write is
 * not a write to synced data and does not go through `sync.submit`: it runs on
 * the plain path, through the front door (coarse check, then the parse) and a
 * plain handler, online only, with no Authority and no dedup ledger. These
 * routes are its real doors, not adapters, on tRPC here and on the relay
 * (`relay.ts` in this module).
 *
 * `router.ts` spreads the result into its `specs` router alongside that router's
 * QUERIES — `list`, `get`, `search` — which are NOT derived: they carry no
 * contract, because a `visibility` class describes what a command WRITES and a
 * read writes nothing. That is the same line `modules/workflows/queries.ts` and
 * `modules/fleet/trpc.ts` draw, and `scripts/audit-spec-commands.ts` checks
 * procedure TYPE rather than name, so a write cannot hide among them by being
 * spelled as a query.
 *
 * ---------------------------------------------------------------------------
 * MEMBERSHIP IS READ OFF THE TABLE, IN BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * A procedure appears here if and only if its contract declares `trpc` (ADR 3
 * D3, default-closed). The plain family builder (`assertSurfaceMatchesDeclarations`) checks that against
 * the object that will actually be SERVED, at module load, in both directions: a
 * contract declaring `trpc` that produced no procedure, and a procedure whose
 * contract does not declare `trpc`, both throw before the server answers a
 * request.
 *
 * The second direction is the one that matters and it is not symmetry for its own
 * sake. Without it, an EMPTY surface satisfies every claim this file makes — the
 * defect POD-732 named ("an empty router satisfies every absence claim
 * perfectly"). The first loop reads `built`, so an empty object fails it rather
 * than passing it.
 *
 * ---------------------------------------------------------------------------
 * THE ROLE FLOOR, AND THE REPO-ROOT GATE
 * ---------------------------------------------------------------------------
 *
 * The front door checks each contract's role floor (`member`) and exposure
 * before the input is parsed; before POD-6418 these routes checked neither. The
 * gate that decides WHERE a spec may be written is still the repo-root
 * allowlist inside `SpecsService`, which every transport runs.
 */

import type { FamilyProcedures } from '../derived-family'
import { plainFamilyProcedures } from '../plain-command/family'
import { SPEC_COMMANDS_TRPC } from './registry'

const NO_QUERIES = {} as const

export type SpecProcedures = FamilyProcedures<typeof SPEC_COMMANDS_TRPC, typeof NO_QUERIES>

/** The three writes, spread into `router.ts`'s `specs` router beside its reads. */
export function specFamilyProcedures(): SpecProcedures {
  return plainFamilyProcedures({
    family: 'specs',
    service: (state) => state.modules.specs,
    commands: SPEC_COMMANDS_TRPC,
    queries: NO_QUERIES,
  })
}
