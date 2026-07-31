import { familyState } from '../derived-family'
/**
 * THE DERIVED SPEC SURFACE (POD-386, the 3.3d cutover) — `specs.create`,
 * `specs.save` and `specs.remove`, produced from the joined table in
 * `registry.ts` rather than written out in `router.ts`.
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
 * D3, default-closed). {@link assertSurfaceMatchesContracts} checks that against
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
 * NO ROLE GATE HERE, AND THAT IS A DECLARATION
 * ---------------------------------------------------------------------------
 *
 * The fleet family derives its base procedure from each contract's `serverRole`
 * because three of its ten are hub-only. Specs have no such split: a spec write
 * lands in a repository working tree on whatever host serves it, and the gate
 * that decides is the repo-root allowlist inside `SpecsService` — which every
 * transport already runs, and which POD-386 deliberately does not move. Reading
 * a `serverRole` that no spec contract declares would be inventing a field.
 */

import type { TRPCMutationProcedure } from '@trpc/server'
import type { z } from 'zod'
import { mods, t } from '../../trpc'
import {
  isSpecCommandExposedOn,
  SPEC_COMMANDS_TRPC,
  type SpecCommandName,
  specCommandsOn,
} from './registry'

type SpecProcedure<N extends SpecCommandName> = TRPCMutationProcedure<{
  meta: unknown
  input: z.input<(typeof SPEC_COMMANDS_TRPC)[N]['contract']['input']>
  output: Awaited<ReturnType<(typeof SPEC_COMMANDS_TRPC)[N]['handler']>>
}>

/**
 * Every derived procedure — a MAPPED type over the table, so a fourth spec write
 * added to `SPEC_COMMANDS_TRPC` appears here without anyone editing this
 * declaration. A hand-written shape would be the second list that silently
 * disagrees with the first.
 */
export type SpecProcedures = { [N in SpecCommandName]: SpecProcedure<N> }

function buildProcedure(name: SpecCommandName): unknown {
  const { contract, handler } = SPEC_COMMANDS_TRPC[name]
  // The table is heterogeneous, so at THIS point the parsed input is the union of
  // all three schemas and TypeScript cannot pair it with the handler. It does not
  // need to: each pairing is checked where it is declared (`SPEC_COMMANDS_TRPC`
  // is `satisfies Record<SpecContractName, SpecCommand>`, and each handler
  // carries a `satisfies SpecHandler<…>` over its own contract's inferred input),
  // and `SpecProcedures` re-derives the per-command types for the client. This
  // erasure is the one place the two meet.
  const run = handler as (svc: ReturnType<typeof mods>['specs'], input: unknown) => unknown
  return t.procedure
    .input(contract.input)
    .mutation(({ ctx, input }) => run(familyState(ctx).modules.specs, input))
}

/**
 * The both-directions exposure check. Called at build time against the object
 * that will actually be served, so an empty one FAILS the first loop rather than
 * satisfying it.
 */
function assertSurfaceMatchesContracts(built: Record<string, unknown>): void {
  for (const name of Object.keys(SPEC_COMMANDS_TRPC) as SpecCommandName[]) {
    const present = built[name] !== undefined
    if (isSpecCommandExposedOn(name, 'trpc') && !present) {
      throw new Error(
        `spec contract specs.${name} declares trpc exposure but the derived router would not serve it`,
      )
    }
    if (!isSpecCommandExposedOn(name, 'trpc') && present) {
      throw new Error(
        `the derived router serves specs.${name}, whose contract does not declare trpc exposure`,
      )
    }
  }
}

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `specs` router. */
export function specFamilyProcedures(): SpecProcedures {
  const built: Record<string, unknown> = {}
  for (const name of specCommandsOn('trpc')) built[name] = buildProcedure(name)
  assertSurfaceMatchesContracts(built)
  return built as unknown as SpecProcedures
}
