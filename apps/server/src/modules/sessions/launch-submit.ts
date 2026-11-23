/** Launch submission and read-only preflight, independent of executor composition. */
import { randomUUID } from 'node:crypto'
import type { DraftIssueArtifactInput } from '@podium/commands'
import {
  type AgentKind,
  asMutationId,
  type MachineId,
  machineRejectionMessage,
  mintDeviceId,
  type SessionId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import {
  checkMachineUse,
  machineAccessMessage,
  machineUseDecision,
  ownershipSnapshotFromMachines,
} from '../../machine-access'
import type { RegistryModules } from '../../relay'
import { refusalAsTrpcError } from '../sync-write/route-adapter'
import type { CreateInput, ResumeInput } from './command-plane'
import type { SessionLaunchInput } from './session-launch-effect'
import { sessionPrincipal } from './session-principal'
import type { SessionSpawnResult } from './session-start'

export const SESSION_LAUNCH_KIND = 'session.launch'
/** How long the old route waits for its launch to settle. */
export const SESSION_LAUNCH_WAIT_MS = 5 * 60 * 1000

/**
 * A launch with no daemon to start on NOW is refused at once, as the route
 * always refused it, and creates no record: the placement gate's own refusal
 * (an unknown machine, one this caller may not use, one that is offline;
 * pinned in oracle-errors), or "no machine is online". These are reads:
 * nothing is prepared or cloned.
 */
export async function refuseUnplaceable(
  modules: RegistryModules,
  principal: Exclude<CommandPrincipal, { kind: 'system' }>,
  input: { machineId?: MachineId; cwd: string; agentKind?: AgentKind },
): Promise<void> {
  if (input.machineId !== undefined && !modules.machines.hasDaemon(input.machineId)) {
    const livePrincipal = await sessionPrincipal(modules, principal.capability)
    const ownership = await ownershipSnapshotFromMachines(modules.machines)
    const failure = checkMachineUse(livePrincipal, input.machineId, ownership)
    if (failure) {
      throw new Error(
        machineAccessMessage(failure, input.machineId, ownership.rowFor(input.machineId)?.name),
      )
    }
    await modules.machines.resolveMachineForAgent(
      input.machineId,
      input.cwd,
      // The reachability checks come before any harness check, so the kind
      // does not change the answer here.
      input.agentKind ?? 'shell',
      (id) => machineUseDecision(livePrincipal, id, ownership),
    )
    const name = await modules.machines.machineName(input.machineId)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: machineRejectionMessage(name, 'no-daemon', 'start a session'),
    })
  }
  if (input.machineId === undefined && modules.machines.onlineMachineIds().length === 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'no machine is online to start this session on',
    })
  }
}

/** A launch's held draft file, as the record names it. */
export type HeldDraftArtifact = NonNullable<SessionLaunchInput['draftArtifactUploads']>[number]

/**
 * Hold a legacy create's browser bytes (`draftArtifacts`) in the pending-upload
 * store, owned by the caller's human, so the launch record names only their ids.
 */
async function holdDraftArtifacts(
  modules: RegistryModules,
  principal: CommandPrincipal,
  artifacts: readonly DraftIssueArtifactInput[],
): Promise<HeldDraftArtifact[]> {
  const ownerUserId = onBehalfOfUser(principal)
  if (ownerUserId === null) throw new Error('session creation requires an accountable human owner')
  const held: HeldDraftArtifact[] = []
  for (const artifact of artifacts) {
    const upload = await modules.pendingUploads.put({
      ownerUserId,
      filename: artifact.filename,
      mediaType: artifact.mimeType,
      bytes: new Uint8Array(Buffer.from(artifact.dataBase64, 'base64')),
    })
    held.push({ id: artifact.id, uploadId: upload.id })
  }
  return held
}

/**
 * `sessions.create` through the effect path, as its caller: create the record,
 * wait for it to settle, answer the old shape (or throw the launch's own
 * refusal). It never starts a session itself (POD-6416): with no daemon to
 * launch on now it refuses at once, as the route always did, and creates no
 * record; a shape the effect refuses is refused with the effect's reason.
 */
export async function createThroughLaunchEffect(
  modules: RegistryModules,
  principal: CommandPrincipal,
  launches: { errorOf(effectId: string): unknown },
  input: CreateInput,
): Promise<SessionSpawnResult> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('sessions.create: no effects module is composed')
  if (principal.kind === 'system') throw new Error('a system principal has no session create')
  await refuseUnplaceable(modules, principal, input)
  const { mutationId: _mutationId, sessionId: given, draftArtifacts, ...fields } = input
  // LEGACY(remove-after: 2027-01): see `draftArtifactUploads`.
  const draftArtifactUploads = draftArtifacts?.length
    ? await holdDraftArtifacts(modules, principal, draftArtifacts)
    : undefined
  const rest = draftArtifactUploads ? { ...fields, draftArtifactUploads } : fields
  const sessionId = given ?? (randomUUID() as SessionId)
  const id = mintDeviceId('eff_')
  const { reply, cause } = await modules.syncWrite.submitDetailed(
    {
      mutationId: asMutationId(`mut_launch_${randomUUID()}`),
      command: 'effects.create',
      version: 1,
      input: {
        id,
        kind: SESSION_LAUNCH_KIND,
        target: { kind: 'session', id: sessionId },
        input: rest,
      },
    },
    principal,
    'trpc',
  )
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) throw cause
    // A session id the effect will not take (the launch target is a NEW v4 id
    // or one this caller may command), or a caller refused on that target.
    throw refusalAsTrpcError('sessions.create', reply.refusal)
  }
  const settled = await effects.awaitSettled(id, SESSION_LAUNCH_WAIT_MS)
  if (settled?.status === 'succeeded') {
    const result = settled.result as SessionSpawnResult | { sessionId: string } | undefined
    if (result && 'agentId' in result) return result
    // Started by an earlier run (the row already existed): the old route never
    // answered this; answer with the id, as a create of that id did.
    return { sessionId } as unknown as SessionSpawnResult
  }
  if (settled?.status === 'failed') {
    throw launches.errorOf(id) ?? new Error(settled.error?.message ?? 'the session could not start')
  }
  throw new Error(
    `session ${sessionId} is ${settled?.status ?? 'unknown'}; it shows on the session list`,
  )
}

/**
 * `sessions.resume` through the effect path, as its caller (POD-6416): a
 * `session.launch` record carrying the resume ref, under a fresh session id.
 * Its run reattaches the row that already holds the conversation (resurrecting
 * a parked one) or spawns a new session under that id; the route answers with
 * the id the run settled on. It never spawns itself.
 */
export async function resumeThroughLaunchEffect(
  modules: RegistryModules,
  principal: CommandPrincipal,
  launches: { errorOf(effectId: string): unknown },
  input: ResumeInput,
): Promise<{ sessionId: SessionId }> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('sessions.resume: no effects module is composed')
  if (principal.kind === 'system') throw new Error('a system principal has no session resume')
  await refuseUnplaceable(modules, principal, input)
  const sessionId = randomUUID() as SessionId
  const id = mintDeviceId('eff_')
  const { reply, cause } = await modules.syncWrite.submitDetailed(
    {
      mutationId: asMutationId(`mut_resume_${randomUUID()}`),
      command: 'effects.create',
      version: 1,
      input: {
        id,
        kind: SESSION_LAUNCH_KIND,
        target: { kind: 'session', id: sessionId },
        input: {
          agentKind: input.agentKind,
          cwd: input.cwd,
          resume: input.resume,
          conversationId: input.conversationId,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
        },
      },
    },
    principal,
    'trpc',
  )
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) throw cause
    throw refusalAsTrpcError('sessions.resume', reply.refusal)
  }
  const settled = await effects.awaitSettled(id, SESSION_LAUNCH_WAIT_MS)
  if (settled?.status === 'succeeded') {
    const result = settled.result as { sessionId?: unknown } | null | undefined
    return {
      sessionId: (typeof result?.sessionId === 'string'
        ? result.sessionId
        : sessionId) as SessionId,
    }
  }
  if (settled?.status === 'failed') {
    throw (
      launches.errorOf(id) ?? new Error(settled.error?.message ?? 'the session could not resume')
    )
  }
  throw new Error(
    `the resume is ${settled?.status ?? 'unknown'}; its session shows on the session list`,
  )
}
