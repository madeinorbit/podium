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

import { join } from 'node:path'
import type { MachineId, UpdateChannel, UserId } from '@podium/model'
import { asMachineId, HOST_REPOS, resolveMachineChannel } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { attributionOf, onBehalfOfUser } from '../../command-principal'
import { normalizeRepoPath } from '../../store'
import type { Context } from '../../trpc'
import { mods } from '../../trpc'
import { fleetAuthzDeps, fleetAuthzFailure, fleetUsePredicate } from './authz'

/** What the composition root supplies that core may not import for itself. */
export interface FleetPorts {
  /**
   * The `podium join …` line for a freshly minted pairing code, or `null` when
   * this instance has no public URL to join to. Built from `hub/machines-join`
   * at the composition root.
   */
  joinCommand: (pairCode: string, podiumManaged?: boolean) => string | null
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
  mods(ctx).machines.renameMachine(asMachineId(input.id), input.name)
  return mods(ctx).machines.listMachines()
}

export const machineSetUpdateChannelHandler = async ({
  ctx,
  input,
}: FleetArgs<{ id: string; channel: UpdateChannel | null }>) => {
  const modules = mods(ctx)
  const machineId = asMachineId(input.id)
  modules.machines.setUpdateChannel(machineId, input.channel)
  // Refresh the channel the machine ACTUALLY lands on, which after a `null` clear
  // is the fleet default rather than anything in the input (POD-1882) — and the
  // fleet default is asked for, not assumed to be a literal (POD-2100).
  await modules.updates.refreshTarget(
    resolveMachineChannel(
      modules.machines.updateChannel(machineId),
      modules.updates.fleetDefaultChannel(),
    ),
  )
  return modules.machines.listMachines()
}

export const machineApplyUpdateHandler = async ({ ctx, input }: FleetArgs<{ id: string }>) => {
  const modules = mods(ctx)
  const machine = modules.machines.listMachines().find((candidate) => candidate.id === input.id)
  if (!machine) throw new TRPCError({ code: 'NOT_FOUND', message: 'machine not found' })
  await modules.updates.refreshTarget(
    resolveMachineChannel(machine.updateChannel, modules.updates.fleetDefaultChannel()),
  )
  // The outcome is what this machine's row will say. Callers must not infer
  // success from a granted-id list: an empty list has five different meanings.
  const outcome = modules.updates.authorizeMachine(asMachineId(input.id), {
    initiator: { kind: 'operator-apply' },
    eligibility: 'a person pressed Apply on this fleet row',
  })
  return { machines: modules.machines.listMachines(), outcome }
}

export const machineShareHandler = ({
  ctx,
  input,
}: FleetArgs<{ id: string; grantee: string; verb: 'see' | 'use' | 'manage' }>) => {
  const principal = fleetAuthzDeps(ctx).principal
  const attribution = attributionOf(principal)
  if (attribution.onBehalfOf === null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'machine sharing requires a human owner' })
  }
  mods(ctx).machines.shareMachine(asMachineId(input.id), input.grantee, input.verb, {
    actor: attribution.actor,
    onBehalfOf: attribution.onBehalfOf,
  })
  return mods(ctx).machines.listMachines()
}

export const machineUnshareHandler = ({
  ctx,
  input,
}: FleetArgs<{ id: string; grantee: string; verb: 'see' | 'use' | 'manage' }>) => {
  const owner = onBehalfOfUser(fleetAuthzDeps(ctx).principal)
  if (owner === null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'machine sharing requires a human owner' })
  }
  mods(ctx).machines.unshareMachine(asMachineId(input.id), input.grantee, input.verb, owner)
  return mods(ctx).machines.listMachines()
}

/**
 * Hand a machine to another person (POD-1480) — the surface D19.4d's ownership
 * transition never had.
 *
 * The OUTGOING owner is read off the transport principal and the INCOMING one
 * off the input, and that asymmetry is the whole security shape: a frame may
 * nominate a recipient, it may not nominate who is asking (ADR 3 D7). A
 * principal with no human behind it — the in-process system principal — cannot
 * own a machine and therefore cannot give one away.
 */
export const machineTransferOwnershipHandler = ({
  ctx,
  input,
}: FleetArgs<{ id: string; newOwnerUserId: UserId }>) => {
  const owner = onBehalfOfUser(fleetAuthzDeps(ctx).principal)
  if (owner === null) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'machine ownership transfer requires a human owner',
    })
  }
  try {
    mods(ctx).machines.transferMachineOwnership(asMachineId(input.id), input.newOwnerUserId, owner)
  } catch (e) {
    return badRequest(e)
  }
  return mods(ctx).machines.listMachines()
}

/**
 * Give an owner to an unowned machine (POD-1494).
 *
 * NOTHING IS READ OFF THE PRINCIPAL HERE, and the contrast with
 * {@link machineTransferOwnershipHandler} directly above is the security shape.
 * Transfer must ask who is calling, because the caller must BE the outgoing
 * owner. Adoption must not, because the caller is not becoming the owner — the
 * admin floor has already decided they may act at all, and the recipient is a
 * named payload field. A handler that quietly adopted "to the caller" would turn
 * an authority into a self-grant, which is the shape D19.4b refused when it
 * declined to auto-assign a quarantined machine to the first admin.
 *
 * The admin may of course name themselves. That is a choice they make in the
 * open and it lands in the ledger with their id on it.
 */
export const machineAdoptHandler = ({
  ctx,
  input,
}: FleetArgs<{ id: string; newOwnerUserId: UserId }>) => {
  try {
    mods(ctx).machines.adoptMachine(asMachineId(input.id), input.newOwnerUserId)
  } catch (e) {
    return badRequest(e)
  }
  return mods(ctx).machines.listMachines()
}

export const machineRevokeHandler = ({ ctx, input }: FleetArgs<{ id: string }>) => {
  mods(ctx).machines.revokeMachine(asMachineId(input.id))
  return mods(ctx).machines.listMachines()
}

/** Move authority only after the target reports a durable promotion. */
export const machineTransferServerHandler = ({
  ctx,
  input,
}: FleetArgs<{
  targetMachineId: MachineId
  publicUrl: string
  port?: number
  confirmation: 'TRANSFER SERVER'
}>) =>
  mods(ctx).serverTransfer.transfer(input, {
    reauthorize: () => {
      const refusal = fleetAuthzFailure('machines.transferServer', input, fleetAuthzDeps(ctx))
      if (refusal) throw refusal
    },
  })

export const machinePairingCodeHandler = ({
  ctx,
  input,
  ports,
}: FleetArgs<{ copyAgentCredentials?: boolean; podiumManaged?: boolean } | undefined>): {
  code: string
  joinCommand: string | null
} => {
  // WHO THE MACHINE WILL BELONG TO IS DECIDED HERE, AT MINT (POD-1079, ADR 9 D6
  // M3: "a newly paired machine is private to its pairer").
  //
  // Resolved from the transport principal, never from the pair frame: the daemon
  // that later redeems this code supplies its own id, name and hostname, and if
  // it could also supply an owner then pairing would be an identity claim from a
  // payload (ADR 3 D7). A code minted by nobody — a system principal, which has
  // no human — carries `null`, and a machine paired with it is owned by nobody
  // and usable by nobody, which is the fail-closed arm rather than a crash.
  const pairer = onBehalfOfUser(fleetAuthzDeps(ctx).principal)
  const code = mods(ctx).machines.mintPairingCode({
    ...(pairer === null ? {} : { ownerUserId: pairer }),
    ...(input?.copyAgentCredentials ? { copyAgentCredentials: true } : {}),
    podiumManaged: input?.podiumManaged ?? true,
  })
  return { code, joinCommand: ports.joinCommand(code, input?.podiumManaged ?? true) }
}

/**
 * REFUSE BEFORE ROUNDTRIPPING (POD-2700 §2.5).
 *
 * Every handler below reaches through a machine's daemon to touch its disk —
 * browse, clone, create, rename, scan. Without this the caller's reward for
 * naming a machine that runs no daemon is a 35-second "no daemon answered"
 * timeout, indistinguishable from a flaky network, and for an OFFLINE machine
 * the queued op may still run later. Naming the axis up front is the difference
 * between "wake it up" and "it can never do this".
 *
 * The `use` axis is already decided a layer above, by `authz.ts`'s per-command
 * gate, so this adds the structural and liveness ones — the two that were
 * missing.
 */
const requireRepoHost = (ctx: Context, machineId: MachineId, action: string): void => {
  try {
    mods(ctx).machines.requireCapability(machineId, HOST_REPOS, action)
  } catch (e) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: e instanceof Error ? e.message : String(e),
    })
  }
}

// ---------------------------------------------------------------------------
// repos.*
// ---------------------------------------------------------------------------

export const repoAddHandler = async ({
  ctx,
  input,
}: FleetArgs<{ path: string; machineId?: MachineId; prefix?: string }>) => {
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
}: FleetArgs<{ paths: string[]; machineId?: MachineId }>) => {
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
}: FleetArgs<{ path: string; machineId?: MachineId }>) => {
  await ctx.repos.remove(input.path, input.machineId)
  return ctx.repos.list()
}

export const repoSetPrefixHandler = ({
  ctx,
  input,
}: FleetArgs<{ path: string; prefix: string; machineId?: MachineId }>) => {
  try {
    ctx.repos.setPrefix(input.path, input.prefix, input.machineId)
  } catch (e) {
    badRequest(e)
  }
  return ctx.registry.sessionStore.repos.listRepos()
}

export const repoCloneGithubHandler = async ({
  ctx,
  input,
}: FleetArgs<{ machineId: MachineId; repository: string; destination: string }>) => {
  requireRepoHost(ctx, input.machineId, 'clone repositories')
  const result = await mods(ctx).rpc.githubCli('clone', input.machineId, {
    repository: input.repository,
    destination: input.destination,
  })
  if (!result.path) {
    const fallback =
      result.status.state === 'missing'
        ? 'GitHub CLI is not installed on this machine'
        : result.status.state === 'logged-out'
          ? 'GitHub CLI is not signed in on this machine'
          : 'GitHub clone failed'
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: result.error ?? fallback })
  }
  await ctx.repos.addKnownOrigin(
    result.path,
    input.machineId,
    `https://github.com/${input.repository}.git`,
  )
  return { path: result.path, repos: ctx.repos.list() }
}

/**
 * THE PICKER'S WRITE PATH (POD-1295).
 *
 * Each of these is one `dirOp` round-trip to the machine that owns the disk.
 * The daemon owns validation and containment — it is the only side that can see
 * the filesystem — so these handlers do exactly two things the daemon cannot:
 * turn its refusal into the right tRPC code, and (for `createRepo`) register the
 * result, the way `repoCloneGithubHandler` registers a clone.
 */
const dirOpFailed = (message: string): never => {
  throw new TRPCError({ code: 'BAD_REQUEST', message })
}

export const repoCreateFolderHandler = async ({
  ctx,
  input,
}: FleetArgs<{ machineId: MachineId; parentPath: string; name: string }>) => {
  requireRepoHost(ctx, input.machineId, 'hold folders')
  const result = await mods(ctx).rpc.dirOp('createFolder', input.machineId, {
    parentPath: input.parentPath,
    name: input.name,
  })
  if (result.error || !result.path) dirOpFailed(result.error ?? 'Could not create the folder')
  return { path: result.path as string }
}

export const repoCreateRepoHandler = async ({
  ctx,
  input,
}: FleetArgs<{ machineId: MachineId; parentPath: string; name: string }>) => {
  requireRepoHost(ctx, input.machineId, 'host repositories')
  const result = await mods(ctx).rpc.dirOp('createRepo', input.machineId, {
    parentPath: input.parentPath,
    name: input.name,
  })
  // `path` WITH `error` is the real case where git could not run: the folder is
  // on disk and the user will see it on the next listing, but it is not a
  // repository, so registering it would hand them a row that breaks on first use.
  if (result.error || !result.path) dirOpFailed(result.error ?? 'Could not create the repository')
  const path = result.path as string
  await ctx.repos.add(path, input.machineId)
  return { path, repos: ctx.repos.list() }
}

export const repoRenameFolderHandler = async ({
  ctx,
  input,
}: FleetArgs<{
  machineId: MachineId
  parentPath: string
  currentName: string
  name: string
}>) => {
  requireRepoHost(ctx, input.machineId, 'hold folders')
  const source = normalizeRepoPath(join(input.parentPath, input.currentName))
  // The folder itself, or anything registered BELOW it: both sets of rows point
  // at paths the rename would invalidate.
  const stranded = ctx.repos
    .list(input.machineId)
    .filter((repo) => repo === source || repo.startsWith(`${source}/`))
  if (stranded.length > 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        stranded[0] === source
          ? `${input.currentName} is registered in Podium. Remove it from your repositories first, then rename it.`
          : `${input.currentName} holds a repository Podium has registered (${stranded[0]}). Remove it from your repositories first, then rename it.`,
    })
  }

  const result = await mods(ctx).rpc.dirOp('renameFolder', input.machineId, {
    parentPath: input.parentPath,
    name: input.name,
    currentName: input.currentName,
  })
  if (result.error || !result.path) dirOpFailed(result.error ?? 'Could not rename the folder')
  return { path: result.path as string }
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
}: FleetArgs<{ path: string; maxDepth?: number; machineId?: MachineId }>) => {
  // The machine is optional here; when it is omitted the scan resolves through
  // `defaultMachine()`, which POD-2700 also taught to prefer a daemon-bearing
  // machine — so guard the id that will actually be used, not the one supplied.
  requireRepoHost(
    ctx,
    input.machineId ?? mods(ctx).machines.defaultMachine(),
    'scan for repositories',
  )
  return ctx.registry.modules.rpc.scanRepos(
    [input.path],
    { includeHome: false, maxDepth: input.maxDepth ?? 6 },
    input.machineId,
  )
}

export const discoveryScanMachineHandler = ({
  ctx,
  input,
}: FleetArgs<{ machineId: MachineId; deep?: boolean; atPath?: string }>) => {
  if (!ctx.discovery)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'discovery unavailable' })
  requireRepoHost(ctx, input.machineId, 'scan for repositories')
  return ctx.discovery.scan(input.machineId, {
    deep: input.deep ?? true,
    ...(input.atPath === undefined ? {} : { atPath: input.atPath }),
  })
}
