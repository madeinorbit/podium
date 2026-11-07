import { settingsAuditAttribution } from '../../store/settings-audit'
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

import { describeError } from '@podium/logger'
import type { MachineId, UpdateChannel, UserId } from '@podium/model'
import { asMachineId, HOST_REPOS, mintDeviceId, resolveMachineChannel } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { attributionOf, onBehalfOfUser } from '../../command-principal'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { RepoRegistry } from '../../repo-registry'
import type { SessionStore } from '../../store'
import { afterCommit } from '../../store/executor/executor'
import type { Context } from '../../trpc'
import { mods } from '../../trpc'
import { awaitEffect } from '../effects/await'
import { linkedOperationId, operationIdForEffect } from '../operations/effects'
import { normalizedPublicUrl, resolvedTransferPort } from '../server-transfer/service'
import { refusalAsTrpcError, submitFromRoute } from '../sync-write/route-adapter'
import { SERVER_MOVE_EFFECT_KIND } from './server-move-effect'
import {
  DIR_OP_FAILED,
  FOLDER_CREATE_KIND,
  FOLDER_EFFECT_WAIT_MS,
  FOLDER_RENAME_KIND,
  type FolderEffectResult,
  REPO_CREATE_KIND,
} from './folder-effects'
import { MACHINE_UPDATE_KIND, MACHINE_UPDATE_WAIT_MS } from './update-effect'
import { machinesForPrincipal, visibleMachinesFor } from '../sessions/command-ctx'
import type { MachineDiscoveryResult } from '../../repo-discovery'
import type { ScanReposResult } from '../machines/rpc'
import type { MachineApplyOutcome } from '../updates/service'
import { type FleetAuthzDeps, fleetAuthzDeps, fleetAuthzFailure, fleetUsePredicate } from './authz'
import {
  FOLDER_SCAN_KIND,
  FOLDER_SCAN_WAIT_MS,
  MACHINE_SCAN_KIND,
  MACHINE_SCAN_WAIT_MS,
  type MachineScanInput,
  REPO_CLONE_KIND,
  REPO_CLONE_WAIT_MS,
  type RepoCloneResult,
  runMachineEffect,
  sameScan,
} from './discovery-effects'

/** What the composition root supplies that core may not import for itself. */
export interface FleetPorts {
  /**
   * The `podium join …` line for a freshly minted pairing code, or `null` when
   * this instance has no public URL to join to. Built from `hub/machines-join`
   * at the composition root.
   */
  joinCommand: (pairCode: string, podiumManaged?: boolean, workspaceId?: string, channel?: import('@podium/model').UpdateChannel) => string | null
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

/**
 * What a fleet write ON THE SYNC WRITE ENTRY POINT runs with (POD-6417): the
 * principal the transport resolved, the gate's view of it, and the modules.
 * Never a request: the same handler serves `sync.submit` and the old routes'
 * adapters, inside the entry point's one unit of work.
 */
export interface FleetWriteEnv {
  readonly modules: RegistryModules
  readonly principal: CommandPrincipal
  readonly authz: FleetAuthzDeps
  readonly repos: RepoRegistry
  readonly store: SessionStore
}

export interface FleetSyncArgs<In> {
  env: FleetWriteEnv
  input: In
}

export type FleetSyncHandler<In, Out> = (args: FleetSyncArgs<In>) => Out | Promise<Out>

/** The caller's view of the fleet, which every machine write answers with: read
 *  after the write, so it shows the grants the write changed. */
const machinesFor = async (env: FleetWriteEnv) =>
  await machinesForPrincipal(env.modules, env.principal)

/** The shipped BAD_REQUEST mapping for store-level validation failures: the
 *  store's own message is what the UI renders, and since POD-3824 that is the
 *  whole `cause` chain rather than whichever wrapper happened to be outermost. */
const badRequest = (e: unknown): never => {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: describeError(e),
  })
}

// ---------------------------------------------------------------------------
// machines.* — hub role
// ---------------------------------------------------------------------------

export const machineSetAssignmentHandler = async ({ env, input }: FleetSyncArgs<{
  id: string; assignment: import('@podium/model').MachineServiceAssignment; requestId: string
}>) => {
  await env.modules.machines.changeAssignment(asMachineId(input.id), input.assignment, input.requestId)
  return await machinesFor(env)
}

export const machineRenameHandler = async ({ env, input }: FleetSyncArgs<{ id: string; name: string }>) => {
  await env.modules.machines.renameMachine(asMachineId(input.id), input.name)
  return await machinesFor(env)
}

export const machineSetUpdateChannelHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ id: string; channel: UpdateChannel | null }>) => {
  const modules = env.modules
  const machineId = asMachineId(input.id)
  await modules.machines.setUpdateChannel(machineId, input.channel)
  // Refresh the channel the machine ACTUALLY lands on, which after a `null` clear
  // is the fleet default rather than anything in the input (POD-1882) — and the
  // fleet default is asked for, not assumed to be a literal (POD-2100). The
  // release feed is the network: asked once the pin has committed (POD-6417),
  // and the clients hear the target it found.
  const channel = resolveMachineChannel(
    await modules.machines.updateChannel(machineId),
    modules.updates.fleetDefaultChannel(),
  )
  afterCommit(async () => {
    await modules.updates.refreshTarget(channel)
    await modules.machines.broadcastMachines()
  }, 'machines:channel:refresh-target')
  return await machinesFor(env)
}

/** A `machine.update` effect record (POD-6417): the release feed, then the grant. */
export const machineApplyUpdateHandler = async ({ ctx, input }: FleetArgs<{ id: string }>) => {
  const modules = mods(ctx)
  const machineId = asMachineId(input.id)
  const row = await runMachineEffect(ctx, {
    command: 'machines.applyUpdate',
    kind: MACHINE_UPDATE_KIND,
    machineId,
    input: {},
    waitMs: MACHINE_UPDATE_WAIT_MS,
  }).catch((error: unknown) => {
    // The machine went away between the gate and the run: the route's answer.
    if (error instanceof TRPCError && error.message === 'machine not found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'machine not found' })
    }
    throw error
  })
  return {
    machines: await machinesForPrincipal(modules, (await fleetAuthzDeps(ctx)).principal),
    outcome: row.result as MachineApplyOutcome,
  }
}

export const machineShareHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ id: string; grantee: string; verb: 'see' | 'use' | 'manage' }>) => {
  const authz = env.authz
  const principal = authz.principal
  const attribution = attributionOf(principal)
  if (attribution.onBehalfOf === null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'machine sharing requires a human owner' })
  }
  await env.modules.machines.shareMachine(asMachineId(input.id), input.grantee, input.verb, {
    actor: attribution.actor,
    onBehalfOf: attribution.onBehalfOf,
    manage: fleetUsePredicate(authz, 'manage'),
  })
  return await machinesFor(env)
}

export const machineUnshareHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ id: string; grantee: string; verb: 'see' | 'use' | 'manage' }>) => {
  const authz = env.authz
  const owner = onBehalfOfUser(authz.principal)
  if (owner === null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'machine sharing requires a human owner' })
  }
  await env.modules.machines.unshareMachine(asMachineId(input.id), input.grantee, input.verb, owner, { manage: fleetUsePredicate(authz, 'manage') })
  return await machinesFor(env)
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
export const machineTransferOwnershipHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ id: string; newOwnerUserId: UserId }>) => {
  const authz = env.authz
  const owner = onBehalfOfUser(authz.principal)
  if (owner === null) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'machine ownership transfer requires a human owner',
    })
  }
  try {
    await env.modules.machines.transferMachineOwnership(asMachineId(input.id), input.newOwnerUserId, owner, { manage: fleetUsePredicate(authz, 'manage'), attribution: settingsAuditAttribution(authz.principal) })
  } catch (e) {
    return badRequest(e)
  }
  return await machinesFor(env)
}

/** Explicit adoption defaults to the authenticated human, never an inferred owner. */
export const machineAdoptHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ id: string; newOwnerUserId?: UserId }>) => {
  const authz = env.authz
  const actor = onBehalfOfUser(authz.principal)
  const recipient = input.newOwnerUserId ?? actor
  if (recipient === null || actor === null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'adoption requires a human recipient' })
  }
  try {
    await env.modules.machines.adoptMachine(asMachineId(input.id), recipient, actor, { manage: fleetUsePredicate(authz, 'manage'), attribution: settingsAuditAttribution(authz.principal) })
  } catch (e) {
    return badRequest(e)
  }
  return await machinesFor(env)
}

export const machineSupersedeHandler = async ({ env, input }: FleetSyncArgs<{ id: MachineId; replacementId: MachineId }>) => {
  const authz = env.authz
  const actor = onBehalfOfUser(authz.principal)
  if (actor === null) throw new TRPCError({ code: 'FORBIDDEN', message: 'supersession requires a human administrator' })
  try {
    await env.modules.machines.supersedeMachine(input.id, input.replacementId, actor, {
      manage: fleetUsePredicate(authz, 'manage'), attribution: settingsAuditAttribution(authz.principal),
    })
  } catch (error) {
    return badRequest(error)
  }
  return await machinesFor(env)
}

export const machineRevokeHandler = async ({ env, input }: FleetSyncArgs<{ id: string }>) => {
  await env.modules.machines.revokeMachine(asMachineId(input.id), { attribution: settingsAuditAttribution(env.principal) })
  return await machinesFor(env)
}

/** How long `machines.moveServer` waits for its record to name its operation. */
export const SERVER_MOVE_START_WAIT_MS = 60_000

/**
 * Move authority only after the target reports a durable promotion. An adapter
 * (POD-6358): the request is a `server.move` effect record created through
 * `sync.submit` as this caller, run by the Operations engine; the route waits
 * until the record names its operation and answers as it always did.
 */
export const machineMoveServerHandler = async ({
  ctx,
  input,
}: FleetArgs<{
  targetMachineId: MachineId
  publicUrl: string
  bindHost: '127.0.0.1' | '0.0.0.0'
  port?: number
  confirmation: 'TRANSFER SERVER'
}>) => {
  // The input's own checks answer as before, before any record exists.
  resolvedTransferPort(input, normalizedPublicUrl(input))
  const id = mintDeviceId('eff_')
  const { reply, cause } = await submitFromRoute(ctx, {
    command: 'effects.create',
    input: {
      id,
      kind: SERVER_MOVE_EFFECT_KIND,
      target: { kind: 'machine', id: input.targetMachineId },
      input,
    },
  })
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) throw cause
    throw refusalAsTrpcError('machines.moveServer', reply.refusal)
  }
  const row = await awaitEffect(
    ctx.registry.sessionStore.effects,
    id,
    (r) => linkedOperationId(r) !== undefined,
    SERVER_MOVE_START_WAIT_MS,
  )
  const operationId = row === undefined ? undefined : linkedOperationId(row)
  if (operationId === operationIdForEffect(id)) return { started: true as const, operationId }
  if (operationId !== undefined) return { started: false as const, alreadyRunning: operationId }
  if (row?.status === 'failed' && row.error?.code === 'no-operation-kind') {
    throw new Error('server-move operation kind is unavailable')
  }
  throw new TRPCError({
    code: row?.status === 'failed' ? 'PRECONDITION_FAILED' : 'TIMEOUT',
    message:
      row?.error?.message ??
      `The server move request ${id} has not started yet; its status shows on every device.`,
  })
}

export const machinePairingCodeHandler = async ({
  ctx,
  input,
  ports,
}: FleetArgs<{ copyAgentCredentials?: boolean; podiumManaged?: boolean; replaceMachineId?: string } | undefined>): Promise<{
  code: string
  joinCommand: string | null
}> => {
  // WHO THE MACHINE WILL BELONG TO IS DECIDED HERE, AT MINT (POD-1079, ADR 9 D6
  // M3: "a newly paired machine is private to its pairer").
  //
  // Resolved from the transport principal, never from the pair frame: the daemon
  // that later redeems this code supplies its own id, name and hostname, and if
  // it could also supply an owner then pairing would be an identity claim from a
  // payload (ADR 3 D7). A code minted by nobody — a system principal, which has
  // no human — carries `null`, and a machine paired with it is owned by nobody
  // and usable by nobody, which is the fail-closed arm rather than a crash.
  const pairer = onBehalfOfUser((await fleetAuthzDeps(ctx)).principal)
  const principal = (await fleetAuthzDeps(ctx)).principal
  if (input?.replaceMachineId) {
    const row = (await mods(ctx).machines.ownershipRows()).find((m) => m.id === input.replaceMachineId)
    const authorized = principal.kind !== 'system' && (principal.capability.role === 'admin' || (pairer !== null && await mods(ctx).machines.effectiveOwner(asMachineId(input.replaceMachineId)) === pairer))
    if (!authorized) throw new TRPCError({ code: 'FORBIDDEN', message: 'replacement requires an administrator or the machine grantee' })
    if (!row?.revokedAt) throw new TRPCError({ code: 'BAD_REQUEST', message: 'replacement requires a revoked machine' })
  } else if (principal.kind === 'system' || principal.capability.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'new enrollment requires an administrator' })
  }
  const grant = {
    ...(pairer === null ? {} : { ownerUserId: pairer }),
    ...(input?.copyAgentCredentials ? { copyAgentCredentials: true } : {}),
    podiumManaged: input?.podiumManaged ?? true,
  }
  const code = input?.replaceMachineId
    ? await mods(ctx).machines.mintReplacementPairingCode(asMachineId(input.replaceMachineId), grant, principal.capability.role === 'admin')
    : mods(ctx).machines.mintPairingCode(grant)

  return { code, joinCommand: pairingJoinCommand({ ctx, input, ports }, code) }
}

/**
 * The `podium join …` line for a minted code, from the composition's port. Apart
 * from the mint because the port is the router's (`router.ts`): the plain
 * registration mints, and its route adds the line (POD-6593).
 */
export function pairingJoinCommand(
  { ctx, input, ports }: FleetArgs<{ podiumManaged?: boolean } | undefined>,
  code: string,
): string | null {
  return ports.joinCommand(code, input?.podiumManaged ?? true, ctx.workspaceId, mods(ctx).updates.fleetDefaultChannel())
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
const requireRepoHost = async (ctx: Context, machineId: MachineId, action: string): Promise<void> => {
  try {
    await mods(ctx).machines.requireCapability(machineId, HOST_REPOS, action)
  } catch (e) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: describeError(e),
    })
  }
}

// ---------------------------------------------------------------------------
// repos.*
// ---------------------------------------------------------------------------

export const repoAddHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ path: string; machineId?: MachineId; prefix?: string }>) => {
  try {
    await env.repos.add(input.path, input.machineId, input.prefix)
  } catch (e) {
    badRequest(e)
  }
  return await env.repos.list()
}

/**
 * Each path is added independently so one bad entry does not drop the rest, and
 * the failures come BACK rather than being thrown — the selection screen renders
 * them. Preserved exactly; see the contract's rationale for why this is a
 * separate command rather than `repos.add` over a list.
 */
export const repoAddManyHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ paths: string[]; machineId?: MachineId }>) => {
  const failed: { path: string; message: string }[] = []
  for (const path of input.paths) {
    try {
      // A refused path is refused before it writes (`RepoRegistry.add` checks
      // first), so the rest still register in the same unit of work.
      await env.repos.add(path, input.machineId)
    } catch (e) {
      failed.push({ path, message: describeError(e) })
    }
  }
  return { repos: await env.repos.list(), failed }
}

export const repoRemoveHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ path: string; machineId?: MachineId }>) => {
  await env.repos.remove(input.path, input.machineId)
  return await env.repos.list()
}

export const repoSetPrefixHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ path: string; prefix: string; machineId?: MachineId }>) => {
  try {
    await env.repos.setPrefix(input.path, input.prefix, input.machineId)
  } catch (e) {
    badRequest(e)
  }
  return await env.store.repos.listRepos()
}

/**
 * The branch was checked on the machine at the target check, before the unit
 * of work (`sync-write.ts`, POD-6417): here it is only stored.
 */
export const repoSetDefaultParentBranchHandler = async ({
  env,
  input,
}: FleetSyncArgs<{ path: string; branch: string | null; machineId?: MachineId }>) => {
  try {
    await env.repos.storeDefaultParentBranch(input.path, input.branch, input.machineId)
  } catch (e) {
    badRequest(e)
  }
  return await env.store.repos.listRepos()
}

/** A `repo.clone` effect record (POD-6396): the clone, its check, its registration. */
export const repoCloneGithubHandler = async ({
  ctx,
  input,
}: FleetArgs<{ machineId: MachineId; repository: string; destination: string }>) => {
  await requireRepoHost(ctx, input.machineId, 'clone repositories')
  const row = await runMachineEffect(ctx, {
    command: 'repos.cloneGithub',
    kind: REPO_CLONE_KIND,
    machineId: input.machineId,
    input: { repository: input.repository, destination: input.destination },
    waitMs: REPO_CLONE_WAIT_MS,
  })
  const { path } = row.result as RepoCloneResult
  return { path, repos: await ctx.repos.list() }
}

/**
 * THE PICKER'S WRITE PATH (POD-1295), as effect records (POD-6417).
 *
 * Each of these is one `dirOp` round trip to the machine that owns the disk, so
 * each is a record (`folder-effects.ts`) created through `sync.submit` as this
 * caller, run from the record and waited for here. The daemon owns validation
 * and containment; its refusal is the BAD_REQUEST it always was.
 */
const folderFailure = (code: string | undefined) =>
  code === DIR_OP_FAILED ? ('BAD_REQUEST' as const) : ('PRECONDITION_FAILED' as const)

export const repoCreateFolderHandler = async ({
  ctx,
  input,
}: FleetArgs<{ machineId: MachineId; parentPath: string; name: string }>) => {
  await requireRepoHost(ctx, input.machineId, 'hold folders')
  const row = await runMachineEffect(ctx, {
    command: 'repos.createFolder',
    kind: FOLDER_CREATE_KIND,
    machineId: input.machineId,
    input: { parentPath: input.parentPath, name: input.name },
    waitMs: FOLDER_EFFECT_WAIT_MS,
    failedCode: folderFailure,
  })
  return { path: (row.result as FolderEffectResult).path }
}

export const repoCreateRepoHandler = async ({
  ctx,
  input,
}: FleetArgs<{ machineId: MachineId; parentPath: string; name: string }>) => {
  await requireRepoHost(ctx, input.machineId, 'host repositories')
  const row = await runMachineEffect(ctx, {
    command: 'repos.createRepo',
    kind: REPO_CREATE_KIND,
    machineId: input.machineId,
    input: { parentPath: input.parentPath, name: input.name },
    waitMs: FOLDER_EFFECT_WAIT_MS,
    failedCode: folderFailure,
  })
  return { path: (row.result as FolderEffectResult).path, repos: await ctx.repos.list() }
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
  await requireRepoHost(ctx, input.machineId, 'hold folders')
  const row = await runMachineEffect(ctx, {
    command: 'repos.renameFolder',
    kind: FOLDER_RENAME_KIND,
    machineId: input.machineId,
    input: { parentPath: input.parentPath, currentName: input.currentName, name: input.name },
    waitMs: FOLDER_EFFECT_WAIT_MS,
    failedCode: folderFailure,
  })
  return { path: (row.result as FolderEffectResult).path }
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
export const discoveryRefreshReposHandler = async ({ ctx }: FleetArgs<void>) => {
  const result = await ctx.repos.scanReposAll(
    fleetUsePredicate(await fleetAuthzDeps(ctx), 'use'),
    fleetUsePredicate(await fleetAuthzDeps(ctx), 'see'),
  )
  // Repositories and machines are one authorization snapshot for the client.
  // Returning the repo rows alone lets a page reload scope a valid durable
  // fallback against an independently timed machine list and hide the project
  // until another event happens to refresh both sides in the right order.
  return {
    ...result,
    machines: await visibleMachinesFor(mods(ctx), ctx.capability),
  }
}

/** A `folder.scan` effect record (POD-6396). */
export const discoveryScanFolderHandler = async ({
  ctx,
  input,
}: FleetArgs<{ path: string; maxDepth?: number; machineId?: MachineId }>) => {
  // The machine is optional here; when it is omitted the scan resolves through
  // `defaultMachine()`, which POD-2700 also taught to prefer a daemon-bearing
  // machine — so guard the id that will actually be used, not the one supplied.
  const machineId = input.machineId ?? (await mods(ctx).machines.defaultMachine())
  await requireRepoHost(ctx, machineId, 'scan for repositories')
  const row = await runMachineEffect(ctx, {
    command: 'discovery.scanFolder',
    kind: FOLDER_SCAN_KIND,
    machineId,
    input: {
      path: input.path,
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    },
    waitMs: FOLDER_SCAN_WAIT_MS,
  })
  return row.result as ScanReposResult
}

/** A `machine.scan` effect record (POD-6396); the same scan already running there is joined. */
export const discoveryScanMachineHandler = async ({
  ctx,
  input,
}: FleetArgs<{ machineId: MachineId; deep?: boolean; atPath?: string }>) => {
  await requireRepoHost(ctx, input.machineId, 'scan for repositories')
  const scan: MachineScanInput = {
    deep: input.deep ?? true,
    ...(input.atPath === undefined ? {} : { atPath: input.atPath }),
  }
  const row = await runMachineEffect(ctx, {
    command: 'discovery.scanMachine',
    kind: MACHINE_SCAN_KIND,
    machineId: input.machineId,
    input: scan,
    waitMs: MACHINE_SCAN_WAIT_MS,
    joins: (running) => sameScan(running, scan),
  })
  return row.result as MachineDiscoveryResult
}
