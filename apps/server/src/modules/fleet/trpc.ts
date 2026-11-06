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
import { assertPlainContract, runPlainCommand } from '../plain-command/entry'
import { plainRefusalError } from '../plain-command/family'
import { refusalAsTrpcError, submitFromRoute } from '../sync-write/route-adapter'
import { fleetAuthzDeps, fleetAuthzFailure } from './authz'
import { MACHINE_SCAN_KIND } from './discovery-effects'
import type { FleetHandler, FleetPorts } from './handlers'
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

/** The input is parsed by the entry point, after the coarse check. */
const unparsed = (raw: unknown): unknown => raw

/**
 * LEGACY(remove-after: 2027-03): a fleet write's old route, as a thin adapter
 * onto `sync.submit` (POD-6417), for the shipped clients that still call it:
 * the desktop app bundles its own web, and an older CLI's `podium machine
 * adopt|supersede`. Removing one breaks that client's write. It answers as the
 * route did: the result, or the gate's or the handler's own error.
 */
function syncAdapter(name: FleetSyncCommandName, base: typeof hubProc | typeof t.procedure) {
  return base.input(unparsed).mutation(async ({ ctx, input }) => {
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
    let answer: Awaited<ReturnType<typeof submitFromRoute>>
    try {
      answer = await submitFromRoute(ctx, { command: name, input })
    } catch (error) {
      refused('service', error)
      throw error
    }
    const { reply, cause } = answer
    if (reply.outcome === 'applied') return reply.result
    const error = cause ?? refusalAsTrpcError(name, reply.refusal)
    refused('authorization', error)
    throw error
  })
}

/**
 * The fleet commands on the PLAIN path (ADR 12 D8, POD-6417).
 * `discovery.refreshRepos` is the boot's repository and machine snapshot: a
 * read of what the machines' daemons report, whose only write is the origins
 * they reported (the server's own write, `RepoRegistry.scanReposAll`). The
 * daemon fan-out runs outside any unit of work, and nothing is recorded for a
 * replay. Its route stays: the shipped mobile app calls it.
 */
const FLEET_PLAIN_COMMANDS: readonly FleetCommandName[] = ['discovery.refreshRepos']

function plainProcedure(
  name: FleetCommandName,
  ports: FleetPorts,
  base: typeof hubProc | typeof t.procedure,
) {
  const { contract, handler } = FLEET_COMMANDS[name]
  const run = handler as FleetHandler<unknown, unknown>
  assertPlainContract(contract)
  return base.input(unparsed).mutation(async ({ ctx, input }) => {
    const reply = await runPlainCommand({
      contract,
      principal: ctx.principal,
      transport: 'trpc',
      input,
      run: async (parsed) => {
        const refusal = await fleetAuthzFailure(name, parsed, await fleetAuthzDeps(ctx))
        if (refusal) throw refusal
        return await run({ ctx, input: parsed, ports })
      },
    })
    if (reply.outcome === 'rejected') throw plainRefusalError(contract, reply.refusal)
    return reply.result
  })
}

function buildProcedure(name: FleetCommandName, ports: FleetPorts): unknown {
  const { contract, handler } = FLEET_COMMANDS[name]
  const base = contract.serverRole === 'hub' ? hubProc : t.procedure
  if (isFleetSyncCommand(name)) return syncAdapter(name, base)
  if (FLEET_PLAIN_COMMANDS.includes(name)) return plainProcedure(name, ports, base)
  // The table is heterogeneous, so at THIS point the handler's input type is the
  // union of all ten and the parsed input is the union of all ten schemas —
  // TypeScript cannot pair them up here. It does not need to: each pairing is
  // checked where it is declared (`FLEET_COMMANDS` is `satisfies
  // Record<FleetContractName, FleetCommand>`, and each handler annotates the
  // input it accepts), and `FleetProcedures` re-derives the per-command types
  // for the client. This erasure is the one place the two meet.
  const run = handler as FleetHandler<unknown, unknown>
  return base.input(contract.input).mutation(async ({ ctx, input }) => {
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
