/**
 * THE TEN FLEET HANDLERS (POD-384) — L3, joined to their L1 contracts in
 * `registry.ts`.
 *
 * Each one is the body of the `router.ts` procedure it replaces, MOVED and not
 * rewritten: the same services, the same error codes, the same return values.
 * The migration's claim is that nothing changed except where the metadata lives,
 * and a handler that "improved" its behaviour on the way past would make that
 * claim unverifiable.
 *
 * ONE THING IS INJECTED RATHER THAN IMPORTED. `buildJoinCommand` lives under
 * `apps/server/src/hub/`, and `roles.ts` rule 1 says core never imports hub —
 * this module is core. So the composition root (which IS allowed to bridge
 * roles) hands the pairing handler a `joinCommand` port. That is the same
 * hexagonal seam the rest of the pack uses, and it is why the hub-only
 * dependency does not drag the whole fleet module into the hub role.
 */

import { TRPCError } from '@trpc/server'
import type { Context } from '../../trpc'
import { mods } from '../../trpc'
import { fleetAuthzDeps, fleetUsePredicate } from './authz'

/** What the composition root supplies that core may not import for itself. */
export interface FleetPorts {
  /**
   * The `podium join …` line for a freshly minted pairing code, or `null` when
   * this instance has no public URL to join to. Built from `hub/machines-join`
   * at the composition root.
   */
  joinCommand: (pairCode: string) => string | null
}

/**
 * What every fleet handler is called with: the tRPC context, the parsed input,
 * and the injected ports.
 *
 * RETURN TYPES ARE INFERRED, NOT DECLARED, and that is load-bearing rather than
 * a style choice. `CommandContract` carries no output schema, so a handler
 * annotated `=> unknown` would type every derived procedure's output `unknown`
 * — and the damage lands on the WEB CLIENT, where `AppRouter` inference is what
 * makes `api.machines.rename.mutate(…)` checked at all. That is not a compile
 * error here; it is a silent loss of checking at every call site, and
 * `router.machines.test.ts` caught it the first time this file declared them.
 */
export interface FleetArgs<In> {
  ctx: Context
  input: In
  ports: FleetPorts
}

/** The erased handler shape the heterogeneous registry table holds. */
export type FleetHandler<In, Out> = (args: FleetArgs<In>) => Out | Promise<Out>

/** The shipped BAD_REQUEST mapping for store-level validation failures, kept
 *  verbatim: the store's own message is what the UI renders. */
const badRequest = (e: unknown): never => {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: e instanceof Error ? e.message : String(e),
  })
}

// ---------------------------------------------------------------------------
// machines.* — hub role
// ---------------------------------------------------------------------------

export const machineRenameHandler = ({ ctx, input }: FleetArgs<{ id: string; name: string }>) => {
  mods(ctx).machines.renameMachine(input.id, input.name)
  return mods(ctx).machines.listMachines()
}

export const machineRevokeHandler = ({ ctx, input }: FleetArgs<{ id: string }>) => {
  mods(ctx).machines.revokeMachine(input.id)
  return mods(ctx).machines.listMachines()
}

export const machinePairingCodeHandler = ({
  ctx,
  input,
  ports,
}: FleetArgs<{ copyAgentCredentials?: boolean } | undefined>): {
  code: string
  joinCommand: string | null
} => {
  const code = mods(ctx).machines.mintPairingCode({
    ...(input?.copyAgentCredentials ? { copyAgentCredentials: true } : {}),
  })
  return { code, joinCommand: ports.joinCommand(code) }
}

// ---------------------------------------------------------------------------
// repos.*
// ---------------------------------------------------------------------------

export const repoAddHandler = async ({
  ctx,
  input,
}: FleetArgs<{ path: string; machineId?: string; prefix?: string }>) => {
  try {
    await ctx.repos.add(input.path, input.machineId, input.prefix)
  } catch (e) {
    badRequest(e)
  }
  return ctx.repos.list()
}

/**
 * Each path is added independently so one bad entry does not drop the rest, and
 * the failures come BACK rather than being thrown — the selection screen renders
 * them. Preserved exactly; see the contract's rationale for why this is a
 * separate command rather than `repos.add` over a list.
 */
export const repoAddManyHandler = async ({
  ctx,
  input,
}: FleetArgs<{ paths: string[]; machineId?: string }>) => {
  const failed: { path: string; message: string }[] = []
  for (const path of input.paths) {
    try {
      await ctx.repos.add(path, input.machineId)
    } catch (e) {
      failed.push({ path, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return { repos: ctx.repos.list(), failed }
}

export const repoRemoveHandler = async ({
  ctx,
  input,
}: FleetArgs<{ path: string; machineId?: string }>) => {
  await ctx.repos.remove(input.path, input.machineId)
  return ctx.repos.list()
}

export const repoSetPrefixHandler = ({
  ctx,
  input,
}: FleetArgs<{ path: string; prefix: string; machineId?: string }>) => {
  try {
    ctx.repos.setPrefix(input.path, input.prefix, input.machineId)
  } catch (e) {
    badRequest(e)
  }
  return ctx.registry.sessionStore.repos.listRepos()
}

// ---------------------------------------------------------------------------
// discovery.* — the `use` family
// ---------------------------------------------------------------------------

/**
 * THE FAN-OUT IS NARROWED, NOT REFUSED (POD-1079).
 *
 * This is the one fleet command whose input names no machine: it refreshes every
 * ONLINE machine. The gate cannot turn that into a single yes/no, so it hands
 * down the predicate instead and the scan visits only the machines this
 * principal holds `use` on. Refusing the whole command whenever one machine in
 * the fleet was somebody else's would make a shared instance unusable; scanning
 * them all would walk a colleague's filesystem through their daemon, which is
 * precisely what `use` is a boundary against.
 */
export const discoveryRefreshReposHandler = ({ ctx }: FleetArgs<void>) =>
  ctx.repos.scanReposAll(fleetUsePredicate(fleetAuthzDeps(ctx), 'use'))

export const discoveryScanFolderHandler = ({
  ctx,
  input,
}: FleetArgs<{ path: string; maxDepth?: number; machineId?: string }>) =>
  ctx.registry.modules.rpc.scanRepos(
    [input.path],
    { includeHome: false, maxDepth: input.maxDepth ?? 6 },
    input.machineId,
  )

export const discoveryScanMachineHandler = ({
  ctx,
  input,
}: FleetArgs<{ machineId: string; deep?: boolean; atPath?: string }>) => {
  if (!ctx.discovery)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'discovery unavailable' })
  return ctx.discovery.scan(input.machineId, {
    deep: input.deep ?? true,
    ...(input.atPath === undefined ? {} : { atPath: input.atPath }),
  })
}
