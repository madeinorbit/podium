/**
 * THE DERIVED FLEET SURFACE (POD-384) — every fleet tRPC mutation, produced from
 * the joined table in `registry.ts` rather than written out.
 *
 * `router.ts` spreads the result into its `machines`, `repos` and `discovery`
 * routers alongside those routers' QUERIES, which are not derived: they have no
 * contracts, because a `visibility` class describes what a command WRITES and a
 * read writes nothing (the same line `modules/workflows/queries.ts` draws).
 *
 * ---------------------------------------------------------------------------
 * THE HUB ROLE GATE IS DERIVED, WHICH IS THE POINT OF THIS ISSUE
 * ---------------------------------------------------------------------------
 *
 * `router.ts` built `hubProc` by hand and each fleet-admin procedure had to
 * remember to use it. Here the base procedure is chosen from the contract's
 * `serverRole`, so the 404-on-wrong-role behaviour follows the DECLARATION.
 * Adding a fleet-admin command without the gate now requires declaring
 * `serverRole: 'core'`, which is a visible claim in a diff rather than an
 * omission nobody can see.
 *
 * The guard's shape is preserved exactly, because "behaviour identical" is the
 * acceptance criterion: `NOT_FOUND` (HTTP 404) and not `FORBIDDEN` — on a node
 * the surface is ABSENT, not permission-gated — and a context that sets no role
 * at all (tests, in-process callers) keeps the historical core+hub shape.
 *
 * ---------------------------------------------------------------------------
 * MEMBERSHIP IS READ OFF THE TABLE, IN BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * A procedure appears here if and only if its contract declares `trpc` (ADR 3
 * D3, default-closed). {@link assertSurfaceMatchesContracts} checks that against
 * the built object at module load, in both directions: a contract that declares
 * `trpc` and produced no procedure, or a procedure whose contract does not
 * declare `trpc`, throws before the server serves a request. Without the second
 * direction an empty surface would satisfy every claim this file makes.
 */

import { FLEET_CONTRACTS } from '@podium/commands'
import type { TRPCMutationProcedure } from '@trpc/server'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import { t } from '../../trpc'
import type { FleetHandler, FleetPorts } from './handlers'
import {
  FLEET_COMMANDS,
  type FleetCommandName,
  fleetCommandsOn,
  isFleetCommandExposedOn,
} from './registry'

/**
 * The hub-role gate, moved from `router.ts` unchanged.
 *
 * NOT_FOUND (→ HTTP 404), not FORBIDDEN — on a node the fleet-admin surface is
 * absent, not permission-gated. Context builders that set no role (tests,
 * in-process callers) keep the historical core+hub shape, which is why the
 * condition is `ctx.role && !ctx.role.hub` and not `!ctx.role?.hub`.
 */
export const hubRoleGuard = t.middleware(({ ctx, next }) => {
  if (ctx.role && !ctx.role.hub) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'not available: this server does not run the hub role',
    })
  }
  return next()
})

const hubProc = t.procedure.use(hubRoleGuard)

// ---------------------------------------------------------------------------
// The shape, derived from the dotted names rather than restated
// ---------------------------------------------------------------------------

/** The router half of a dotted name (`repos.add` → `repos`). */
type RouterOf<N extends string> = N extends `${infer R}.${string}` ? R : never

type FleetProcedure<N extends FleetCommandName> = TRPCMutationProcedure<{
  meta: unknown
  input: z.input<(typeof FLEET_COMMANDS)[N]['contract']['input']>
  output: Awaited<ReturnType<(typeof FLEET_COMMANDS)[N]['handler']>>
}>

/**
 * Every derived procedure, grouped by the router it belongs on — a MAPPED type
 * over the table, so a command added to `FLEET_COMMANDS` appears here without
 * anyone editing this declaration. A hand-written shape would be the second
 * list that silently disagrees with the first.
 */
export type FleetProcedures = {
  [R in RouterOf<FleetCommandName>]: {
    [N in FleetCommandName as N extends `${R}.${infer K}` ? K : never]: FleetProcedure<N>
  }
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

function buildProcedure(name: FleetCommandName, ports: FleetPorts): unknown {
  const { contract, handler } = FLEET_COMMANDS[name]
  const base = contract.serverRole === 'hub' ? hubProc : t.procedure
  // The table is heterogeneous, so at THIS point the handler's input type is the
  // union of all ten and the parsed input is the union of all ten schemas —
  // TypeScript cannot pair them up here. It does not need to: each pairing is
  // checked where it is declared (`FLEET_COMMANDS` is `satisfies
  // Record<FleetContractName, FleetCommand>`, and each handler annotates the
  // input it accepts), and `FleetProcedures` re-derives the per-command types
  // for the client. This erasure is the one place the two meet.
  const run = handler as FleetHandler<unknown, unknown>
  return base.input(contract.input).mutation(({ ctx, input }) => run({ ctx, input, ports }))
}

/**
 * The both-directions exposure check. Called at build time, and it must be able
 * to say NO from BOTH sides: `built` is the object that will actually be served,
 * so an empty one fails the first loop rather than satisfying it.
 */
function assertSurfaceMatchesContracts(built: Record<string, Record<string, unknown>>): void {
  for (const name of Object.keys(FLEET_CONTRACTS) as FleetCommandName[]) {
    const [router, key] = name.split('.') as [string, string]
    const present = built[router] !== undefined && built[router][key] !== undefined
    if (isFleetCommandExposedOn(name, 'trpc') && !present) {
      throw new Error(
        `fleet contract ${name} declares trpc exposure but the derived router would not serve it`,
      )
    }
    if (!isFleetCommandExposedOn(name, 'trpc') && present) {
      throw new Error(
        `the derived router serves ${name}, whose contract does not declare trpc exposure`,
      )
    }
  }
}

/**
 * THE DERIVED PROCEDURES. `ports` carries what core may not import for itself —
 * today that is the hub's join-command builder, supplied by `router.ts`.
 */
export function fleetProcedures(ports: FleetPorts): FleetProcedures {
  const grouped: Record<string, Record<string, unknown>> = {}
  for (const name of fleetCommandsOn('trpc')) {
    const [router, key] = name.split('.') as [string, string]
    grouped[router] ??= {}
    grouped[router][key] = buildProcedure(name, ports)
  }
  assertSurfaceMatchesContracts(grouped)
  return grouped as unknown as FleetProcedures
}
