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
import { createLogger } from '@podium/logger'
import { MachineIdField } from '@podium/model'
import type { TRPCMutationProcedure } from '@trpc/server'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { MachineDiscoveryResult } from '../../repo-discovery'
import { settingsAuditAttribution } from '../../store/settings-audit'
import { mods, t } from '../../trpc'
import type { DetailedSubmit } from '../sync-write/entry'
import { refusalAsTrpcError } from '../sync-write/route-adapter'
import type { RouteMiddleware } from '../write-routes/builder'
import { plainRoute } from '../write-routes/plain'
import { syncRoute } from '../write-routes/sync'
import { fleetAuthzDeps, fleetAuthzFailure } from './authz'
import { MACHINE_SCAN_KIND } from './discovery-effects'
import { type FleetHandler, type FleetPorts, pairingJoinCommand } from './handlers'
import { FLEET_PLAIN_COMMANDS } from './plain-family'
import {
  FLEET_COMMANDS,
  type FleetCommandName,
  fleetCommandsOn,
  isFleetCommandExposedOn,
} from './registry'
import { type FleetSyncCommandName, isFleetSyncCommand } from './sync-write'

/**
 * The hub-role gate, moved from `router.ts` unchanged.
 *
 * NOT_FOUND (→ HTTP 404), not FORBIDDEN — on a node the fleet-admin surface is
 * absent, not permission-gated. Context builders that set no role (tests,
 * in-process callers) keep the historical core+hub shape, which is why the
 * condition is `ctx.role && !ctx.role.hub` and not `!ctx.role?.hub`.
 */
export const hubRoleGuard = t.middleware(async ({ ctx, next }) => {
  if (ctx.role && !ctx.role.hub) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'not available: this server does not run the hub role',
    })
  }
  return await next()
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

/** The fleet writes on the sync write entry point whose per-command route is
 *  deleted: no shipped client ever called it (POD-6417). `sync.submit` is their
 *  only door. */
export const FLEET_SUBMIT_ONLY = [
  'machines.share',
  'machines.unshare',
  'machines.setAssignment',
] as const satisfies readonly FleetSyncCommandName[]

type FleetRoutedName = Exclude<FleetCommandName, (typeof FLEET_SUBMIT_ONLY)[number]>

const isSubmitOnly = (name: string): boolean =>
  (FLEET_SUBMIT_ONLY as readonly string[]).includes(name)

/**
 * Every derived procedure, grouped by the router it belongs on — a MAPPED type
 * over the table, so a command added to `FLEET_COMMANDS` appears here without
 * anyone editing this declaration. A hand-written shape would be the second
 * list that silently disagrees with the first.
 */
export type FleetProcedures = {
  [R in RouterOf<FleetCommandName>]: {
    [N in FleetRoutedName as N extends `${R}.${infer K}` ? K : never]: FleetProcedure<N>
  }
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

const log = createLogger('server:fleet')

/**
 * LEGACY(remove-after: 2027-03): a fleet write's old route, as a thin adapter
 * onto `sync.submit` (POD-6417), for the shipped clients that still call it:
 * the desktop app bundles its own web, and an older CLI's `podium machine
 * adopt|supersede`. Removing one breaks that client's write. It answers as the
 * route did: the result, or the gate's or the handler's own error.
 */
function syncAdapter(name: FleetSyncCommandName, use: readonly RouteMiddleware[]) {
  return syncRoute({
    command: FLEET_CONTRACTS[name],
    use,
    run: async ({ ctx, input, submit }) => {
      // A revoke's refusal is logged with who asked (POD-1079): at the gate (a
      // refusal reply) or in the service (a throw).
      const refused = (stage: 'authorization' | 'service', error: unknown) => {
        if (name !== 'machines.revoke') return
        log.warn('machine revoke refused', {
          machineId: (input as { id?: string } | undefined)?.id,
          ...settingsAuditAttribution(ctx.principal),
          stage,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      let answer: DetailedSubmit
      try {
        answer = await submit()
      } catch (error) {
        refused('service', error)
        throw error
      }
      const { reply, cause } = answer
      if (reply.outcome === 'applied') return reply.result
      const error = cause ?? refusalAsTrpcError(name, reply.refusal)
      refused('authorization', error)
      throw error
    },
  })
}

/**
 * The fleet writes that are effect records (POD-6396, POD-6358): each old route
 * keeps its schema, the derived gate and its handler, which creates the record
 * through `sync.submit` as this caller and answers once it settles. They reach
 * `effects.create`.
 */
const FLEET_EFFECT_COMMANDS = [
  'machines.applyUpdate',
  'machines.moveServer',
  'repos.cloneGithub',
  'repos.createFolder',
  'repos.createRepo',
  'repos.renameFolder',
  'discovery.scanFolder',
  'discovery.scanMachine',
] as const satisfies readonly FleetCommandName[]

const isPlain = (name: FleetCommandName): boolean =>
  (FLEET_PLAIN_COMMANDS as readonly string[]).includes(name)

const isEffect = (name: FleetCommandName): boolean =>
  (FLEET_EFFECT_COMMANDS as readonly string[]).includes(name)

function buildProcedure(name: FleetCommandName, ports: FleetPorts): unknown {
  const { contract, handler } = FLEET_COMMANDS[name]
  const use: readonly RouteMiddleware[] = contract.serverRole === 'hub' ? [hubRoleGuard] : []
  if (isFleetSyncCommand(name)) return syncAdapter(name, use)
  if (name === 'machines.pairingCode') return pairingCodeProcedure(ports, use)
  if (isPlain(name)) return plainRoute(name, { use })
  // The table is heterogeneous, so at THIS point the handler's input type is the
  // union of all ten and the parsed input is the union of all ten schemas —
  // TypeScript cannot pair them up here. It does not need to: each pairing is
  // checked where it is declared (`FLEET_COMMANDS` is `satisfies
  // Record<FleetContractName, FleetCommand>`, and each handler annotates the
  // input it accepts), and `FleetProcedures` re-derives the per-command types
  // for the client. This erasure is the one place the two meet.
  const run = handler as FleetHandler<unknown, unknown>
  if (!isEffect(name)) throw new Error(`fleet: ${name} is on no write path`)
  return syncRoute({
    command: contract,
    registration: 'effects.create',
    input: contract.input,
    use,
    run: async ({ ctx, input }) => {
      // THE AUTHORIZATION GATE, DERIVED (POD-1079). It runs for every fleet
      // command from the contract's own `roleFloor` and `machineVerb`, before the
      // handler and after input parsing — the verb needs to know WHICH machine,
      // and only the parsed input can say. A per-handler check would be ten places
      // to forget; this is one, and `authz.ts`'s target table makes a new command
      // that declares a verb a COMPILE error until it says how its machine is
      // named.
      const authz = await fleetAuthzDeps(ctx)
      const refusal = await fleetAuthzFailure(name, input, authz)
      if (refusal) throw refusal
      return await run({ ctx, input, ports })
    },
  })
}

/**
 * `machines.pairingCode` (a plain registration, `plain-family.ts`): the route
 * adds the `podium join …` line from the router's port to the code the
 * registration minted.
 */
function pairingCodeProcedure(ports: FleetPorts, use: readonly RouteMiddleware[]): unknown {
  return plainRoute('machines.pairingCode', {
    use,
    answer: (result, { ctx, input }) => {
      const { code } = result as { code: string }
      return {
        code,
        joinCommand: pairingJoinCommand(
          { ctx, input: input as { podiumManaged?: boolean } | undefined, ports },
          code,
        ),
      }
    },
  })
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
    if (isSubmitOnly(name)) {
      // Served on tRPC through `sync.submit` alone (POD-6417): its route must be gone.
      if (present) throw new Error(`the derived router serves ${name}, whose route was deleted`)
      continue
    }
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
    if (isSubmitOnly(name)) continue
    const [router, key] = name.split('.') as [string, string]
    grouped[router] ??= {}
    grouped[router][key] = buildProcedure(name, ports)
  }
  assertSurfaceMatchesContracts(grouped)
  return grouped as unknown as FleetProcedures
}

/**
 * `discovery.lastMachineScan`: the machine's most recent finished discovery
 * (e.g. the automatic connect scan), so the picker can show results without
 * re-scanning. It is the result of the machine's newest succeeded
 * `machine.scan` effect record (POD-6396), and a scan's result is a listing of
 * that machine's disk, so it is read under the scan's own gate: the
 * `discovery.scanMachine` contract's role floor and machine `use`, live.
 * Hand-written for that reason: a query-table read carries no principal.
 */
export const discoveryReadProcedures = () => ({
  lastMachineScan: t.procedure
    .input(z.object({ machineId: MachineIdField }))
    .query(async ({ ctx, input }): Promise<MachineDiscoveryResult | null> => {
      const refusal = await fleetAuthzFailure(
        'discovery.scanMachine',
        { machineId: input.machineId },
        await fleetAuthzDeps(ctx),
      )
      if (refusal) throw refusal
      const row = await mods(ctx).effects?.newestOnTarget(
        MACHINE_SCAN_KIND,
        { kind: 'machine', id: input.machineId },
        'succeeded',
      )
      return (row?.result as MachineDiscoveryResult | undefined) ?? null
    }),
})
