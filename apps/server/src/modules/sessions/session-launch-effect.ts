/**
 * STARTING A SESSION IS AN EFFECT RECORD (POD-6398, ADR 12 D5 E2; coordinator
 * decision on POD-6241).
 *
 * A new session cannot be written before it is placed: its `cwd` on the target
 * machine (which may need a clone), the machine an implicit placement picks,
 * and the draft task it joins are decided by a placement that talks to the
 * daemon. So a start is a one-off action on a machine: an effect record of kind
 * `session.launch`, created through `effects.create` with an id minted on the
 * device, whose TARGET is the session id the device also minted. Every device
 * sees it pending ("Starting…", also while the machine is offline), running,
 * and how it ended; the session row is born under that id when it succeeds.
 *
 *  - READY: only while a daemon can take it (its machine, or any machine for
 *    an implicit placement). Not ready leaves it pending; the machine's attach
 *    pokes it, the sweep asks again, and the 24-hour deadline expires it unrun
 *    ("machine was offline", as the effect's `expired`).
 *  - RUN: once per id. A session row already under the target id means an
 *    earlier run got as far as the spawn (the row is persisted before the
 *    spawn frame is sent), so it succeeds without starting anything. Otherwise
 *    the writer is checked again, NOW: an active account, its current role, and
 *    machine `use` on an explicit placement (narrowed by the writing agent's
 *    delegation). Then `sessions.create`'s own code runs under that principal
 *    and that id. Credentials are resolved there, never stored.
 *  - RECOVER: a row under the id is `succeeded`; none means nothing was
 *    spawned, so it is safely `failed` ("interrupted").
 *  - PUBLISH: the feed carries where it starts (agent, folder, machine, issue,
 *    model, its draft task's place), never the first prompt or the attachments.
 *  - THE OLD ROUTE: `sessions.create` creates the record through `sync.submit`
 *    as its caller and waits for it to settle, answering its old shape.
 */

import { randomUUID } from 'node:crypto'
import { sessionCommandPlaneInputs } from '@podium/commands'
import {
  type AgentKind,
  asMutationId,
  asUserId,
  type EffectTarget,
  type MachineId,
  machineRejectionMessage,
  mintDeviceId,
  NewSessionId,
  type SessionId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  attributionOf,
  type CommandPrincipal,
  onBehalfOfUser,
  userCommandPrincipal,
} from '../../command-principal'
import { checkMachineUse, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { UsersRepository } from '../../store/users'
import type { EffectExecutor, EffectOutcome } from '../effects/registry'
import { NO_TARGET } from '../sync-write/registry'
import { refusalAsTrpcError } from '../sync-write/route-adapter'
import { sessionCommandCtx } from './command-ctx'
import {
  type CreateInput,
  createSessionNow,
  type ResumeInput,
  resumeSessionNow,
} from './command-plane'
import { NO_LONGER_ALLOWED } from './lifecycle-controller'
import type { SessionSpawnResult } from './session-start'

export const SESSION_LAUNCH_KIND = 'session.launch'

/** A launch whose machine has not attached for this long expires unrun. */
export const SESSION_LAUNCH_DEADLINE_MS = 24 * 60 * 60 * 1000

/** How long the old route waits for its launch to settle. */
export const SESSION_LAUNCH_WAIT_MS = 5 * 60 * 1000

/**
 * The launch input: `sessions.create`'s own schema, without the id (the
 * record's target), the route's dedup key, and the legacy browser bytes, which
 * never go into a stored record.
 */
export const SessionLaunchInput = sessionCommandPlaneInputs.create
  .omit({
    sessionId: true,
    mutationId: true,
    draftArtifacts: true,
  })
  .extend({
    /**
     * A RESUME (POD-6416): the durable conversation to reattach, as
     * `sessions.resume` names it. The run reuses the row that holds it
     * (resurrecting a parked one) or spawns a fresh session under the record's
     * target. With it, `agentKind` and `conversationId` are required
     * ({@link resumeInputOf}).
     */
    resume: sessionCommandPlaneInputs.resume.shape.resume.optional(),
    conversationId: sessionCommandPlaneInputs.resume.shape.conversationId.optional(),
    /**
     * A WAKE WITH A SELECTION (POD-6415): a chat send naming --model/--effort for
     * a parked session. With a resume, the parked row it lands on is woken with
     * these choices; a live row refuses them. The send that asked checked them.
     */
    wake: z
      .object({
        model: z.string().min(1).optional(),
        effort: z.string().min(1).optional(),
        forceUnknownModel: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /**
     * AN AGENT'S SPAWN (POD-6525): `podium agent spawn`, whose write decided
     * everything a start decides (the issue, its folder, the harness, the
     * machine, the budget) and checked it. The run starts the child as the
     * spawn always did, under the spawning session and the issue's owner.
     */
    spawnAgent: z
      .object({
        /** The session's owner: the issue's, else the spawner's human. */
        ownerUserId: z.string().min(1),
        /** The spawner (`session:<id>`, `user`, `agent`): the child's parent. */
        spawnedBy: z.string().min(1),
        /** The curated name the spawner gave it (`--title`). */
        name: z.string().min(1).optional(),
        workflowRunId: z.string().optional(),
        workflowStepId: z.string().optional(),
        agentProfileId: z.string().optional(),
      })
      .strict()
      .optional(),
  })
export type SessionLaunchInput = z.infer<typeof SessionLaunchInput>

/** A resume launch's input as `sessions.resume` takes it; undefined when it is not one. */
function resumeInputOf(input: SessionLaunchInput) {
  if (input.resume === undefined) return undefined
  return sessionCommandPlaneInputs.resume.safeParse({
    agentKind: input.agentKind,
    cwd: input.cwd,
    resume: input.resume,
    conversationId: input.conversationId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
  })
}

export interface SessionLaunchEffectDeps {
  modules(): RegistryModules
  /** The writer's account as it is now. */
  users: Pick<UsersRepository, 'get'>
}

/** The launch's own refusal, kept in process for the old route (bounded). */
const RECENT_ERRORS = 256

export function registerSessionLaunchEffect(deps: SessionLaunchEffectDeps): {
  /** The thrown refusal of a launch this process ran, for the old route's answer. */
  errorOf(effectId: string): unknown
} {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('session launch: no effects module')
  const errors = new Map<string, unknown>()
  const remember = (id: string, error: unknown) => {
    errors.set(id, error)
    if (errors.size > RECENT_ERRORS) {
      const oldest = errors.keys().next().value
      if (oldest !== undefined) errors.delete(oldest)
    }
  }

  const sessionExists = async (id: string) =>
    await deps.modules().sessions.sessionRowExists(id as SessionId)

  const reachable = (machineId: MachineId | undefined) => {
    const machines = deps.modules().machines
    return machineId === undefined
      ? machines.onlineMachineIds().length > 0
      : machines.hasDaemon(machineId)
  }

  /** The writer as they are NOW: their row, their current role. */
  const writerOf = async (record: EffectRow) => {
    if (record.createdBy === null) return undefined
    const user = await deps.users.get(record.createdBy)
    if (!user || user.disabledAt) return undefined
    return user
  }

  /** The writing agent, when an agent wrote it (`session:<id>`). */
  const agentOf = (record: EffectRow): SessionId | undefined =>
    record.actor?.startsWith('session:')
      ? (record.actor.slice('session:'.length) as SessionId)
      : undefined

  const mayUse = async (
    record: EffectRow,
    machineId: MachineId,
    role: Parameters<typeof userCommandPrincipal>[1],
  ) => {
    const machines = deps.modules().machines
    const ownership = await ownershipSnapshotFromMachines(machines)
    if (record.createdBy === null) return false
    if (checkMachineUse(userCommandPrincipal(record.createdBy, role), machineId, ownership))
      return false
    const agent = agentOf(record)
    const delegated = agent ? ownership.delegatedMachines?.(agent) : undefined
    return delegated === undefined || delegated.has(machineId)
  }

  const run = async (record: EffectRow, input: SessionLaunchInput): Promise<EffectOutcome> => {
    const sessionId = record.target.id as SessionId
    if (await sessionExists(sessionId)) {
      return { status: 'succeeded', result: { sessionId, output: 'already started' } }
    }
    const writer = await writerOf(record)
    if (!writer) return refused(NO_LONGER_ALLOWED)
    if (input.machineId !== undefined && !(await mayUse(record, input.machineId, writer.role))) {
      return refused(NO_LONGER_ALLOWED)
    }
    if (input.spawnAgent !== undefined) {
      try {
        return {
          status: 'succeeded',
          result: await spawnAgentNow(deps.modules(), sessionId, input, input.spawnAgent),
        }
      } catch (error) {
        remember(record.id, error)
        return refused(error instanceof Error ? error.message : String(error))
      }
    }
    const capability = userCommandPrincipal(asUserId(writer.id), writer.role).capability
    const ctx = await sessionCommandCtx(deps.modules(), capability, false, 'trpc')
    const resumed = resumeInputOf(input)
    try {
      if (resumed !== undefined) {
        if (!resumed.success) return refused('a resume names its agent and its conversation')
        // The row that holds the conversation, or a fresh one under this id.
        return {
          status: 'succeeded',
          result: await resumeSessionNow(ctx, resumed.data, sessionId, input.wake),
        }
      }
      const parsed: CreateInput = sessionCommandPlaneInputs.create.parse({ ...input, sessionId })
      const result: SessionSpawnResult = await createSessionNow(ctx, parsed)
      return { status: 'succeeded', result }
    } catch (error) {
      remember(record.id, error)
      return refused(error instanceof Error ? error.message : String(error))
    }
  }

  const executor: EffectExecutor<SessionLaunchInput> = {
    kind: SESSION_LAUNCH_KIND,
    // Its parsed form is the input type; zod's input form differs only by the
    // branded ids it brands while parsing.
    input: SessionLaunchInput as unknown as z.ZodType<SessionLaunchInput>,
    deadlineMs: SESSION_LAUNCH_DEADLINE_MS,
    /**
     * A NEW session id, or one this caller may already command (a create that
     * names a session that exists does nothing). The creator always sees their
     * own record on the feed; nobody else can learn its id.
     */
    target: async (target: EffectTarget, principal: CommandPrincipal) => {
      if (principal.kind === 'system' || target.kind !== 'session') return undefined
      if (!NewSessionId.safeParse(target.id).success) return undefined
      if (!(await sessionExists(target.id))) return NO_TARGET
      const plane = await sessionCommandCtx(deps.modules(), principal.capability, false, 'trpc')
      try {
        return (await plane.target(target.id as SessionId, 'sessions.stop')) === undefined
          ? undefined
          : NO_TARGET
      } catch {
        return undefined
      }
    },
    /**
     * A resume names its agent and its conversation, or it is refused now. An
     * agent's spawn is created only by `mail.spawnAgent`'s own write, which
     * checked what it names (the owner, the parent): nobody creates one through
     * `effects.create` (POD-6525).
     */
    admit: async (input) =>
      input.spawnAgent !== undefined
        ? { kind: 'invalid', message: 'an agent spawn is started with `podium agent spawn`' }
        : resumeInputOf(input)?.success === false
          ? { kind: 'invalid', message: 'a resume names its agent and its conversation' }
          : undefined,
    publish: (input) => ({
      ...(input.agentKind !== undefined ? { agentKind: input.agentKind } : {}),
      cwd: input.cwd,
      ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
      ...(input.issueId !== undefined ? { issueId: input.issueId } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.wake !== undefined ? { wake: input.wake } : {}),
      // Where its draft task goes (POD-6408): a device that reloads while the
      // launch waits paints the task's placeholder from this. Not a secret.
      ...(input.draftIssue !== undefined ? { draftIssue: input.draftIssue } : {}),
    }),
    ready: (_record, input) => reachable(input.machineId),
    run: async (ctx) => await run(ctx.record, ctx.input),
    recover: async (ctx) =>
      (await sessionExists(ctx.record.target.id))
        ? { status: 'succeeded', result: { sessionId: ctx.record.target.id } }
        : ctx.input.resume !== undefined
          ? {
              // A resume may have landed on the row that already held the
              // conversation; asking again finds it and does nothing twice.
              status: 'failed',
              error: {
                code: 'interrupted',
                message: 'The server stopped while resuming; resume again to reattach.',
              },
            }
          : {
              status: 'failed',
              error: {
                code: 'interrupted',
                message: 'The server stopped before the session started; nothing was started.',
              },
            },
  }
  effects.executors.register(executor)

  // A machine attached: its waiting launches (and those that name no machine)
  // can start now rather than at the next sweep.
  deps
    .modules()
    .bus.on('machine.connected', () =>
      effects.runner.poke(SESSION_LAUNCH_KIND).catch(() => undefined),
    )

  return { errorOf: (id) => errors.get(id) }
}

/**
 * An agent's spawn, run (POD-6525): wait for the machine's first inventory of
 * this connection (a daemon that just attached is online before its probe
 * ends), then the one spawn path, under the record's session id. The write
 * already placed and checked it; the writer was checked again just now.
 */
async function spawnAgentNow(
  modules: RegistryModules,
  sessionId: SessionId,
  input: SessionLaunchInput,
  spawn: NonNullable<SessionLaunchInput['spawnAgent']>,
): Promise<SessionSpawnResult> {
  if (input.machineId !== undefined && input.agentKind !== 'shell') {
    await modules.machines.waitForInventory(input.machineId)
  }
  return await modules.sessions.createSession({
    requestTerminalDriver: true,
    sessionId,
    ownerUserId: asUserId(spawn.ownerUserId),
    cwd: input.cwd,
    ...(input.agentKind !== undefined ? { agentKind: input.agentKind } : {}),
    ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.forceUnknownModel ? { forceUnknownModel: true } : {}),
    ...(input.issueId !== undefined ? { issueId: input.issueId } : {}),
    spawnedBy: spawn.spawnedBy,
    ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
    ...(spawn.name !== undefined ? { name: spawn.name } : {}),
    ...(spawn.workflowRunId !== undefined ? { workflowRunId: spawn.workflowRunId } : {}),
    ...(spawn.workflowStepId !== undefined ? { workflowStepId: spawn.workflowStepId } : {}),
    ...(spawn.agentProfileId !== undefined ? { agentProfileId: spawn.agentProfileId } : {}),
  })
}

const refused = (message: string): EffectOutcome => ({
  status: 'failed',
  error: { code: 'refused', message },
})

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
    const plane = await sessionCommandCtx(modules, principal.capability, false, 'trpc')
    plane.assertMachineUse(input.machineId)
    await modules.machines.resolveMachineForAgent(
      input.machineId,
      input.cwd,
      // The reachability checks come before any harness check, so the kind
      // does not change the answer here.
      input.agentKind ?? 'shell',
      plane.machineUse,
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
  const { mutationId: _mutationId, sessionId: given, draftArtifacts: _bytes, ...rest } = input
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

/**
 * AN AGENT'S SPAWN, CREATED IN ITS WRITE (POD-6525): the `session.launch` record
 * of `mail.spawnAgent`, in the write's own unit of work, attributed to the
 * spawner (its human, and the spawning session as actor). Its run checks that
 * writer again before it starts anything.
 */
export async function createSpawnLaunchInUnit(
  modules: RegistryModules,
  principal: CommandPrincipal,
  launch: { sessionId: SessionId; input: Record<string, unknown> },
): Promise<{ effectId: string }> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('agent spawn: no effects module is composed')
  const effectId = mintDeviceId('eff_')
  await effects.createForSession({
    id: effectId,
    kind: SESSION_LAUNCH_KIND,
    target: { kind: 'session', id: launch.sessionId },
    input: launch.input,
    createdBy: onBehalfOfUser(principal),
    actor: attributionOf(principal).actor,
  })
  return { effectId }
}

/**
 * Wait for an agent's spawn record to settle (POD-6525), for the adapter that
 * answers `podium agent spawn` as before: the start's result, or the start's
 * own refusal thrown. A record that started its child on an earlier run
 * answers with the child's id.
 */
export async function settledSpawnLaunch(
  modules: RegistryModules,
  effectId: string,
): Promise<SessionSpawnResult | { sessionId: string }> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('agent spawn: no effects module is composed')
  const settled = await effects.awaitSettled(effectId, SESSION_LAUNCH_WAIT_MS)
  if (settled?.status === 'succeeded') {
    const result = settled.result as SessionSpawnResult | { sessionId: string } | undefined
    if (result !== undefined && typeof result.sessionId === 'string') return result
    return { sessionId: settled.target.id }
  }
  if (settled?.status === 'failed') {
    throw (
      modules.sessionLaunches?.errorOf(effectId) ??
      new Error(settled.error?.message ?? 'the agent could not start')
    )
  }
  throw new Error(
    `the agent's start is ${settled?.status ?? 'unknown'}; its session shows on the session list`,
  )
}
