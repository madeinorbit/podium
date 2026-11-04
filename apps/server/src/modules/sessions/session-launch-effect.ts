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
  asMutationId,
  asUserId,
  type EffectTarget,
  type MachineId,
  mintDeviceId,
  NewSessionId,
  type SessionId,
} from '@podium/model'
import type { z } from 'zod'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import { checkMachineUse, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { UsersRepository } from '../../store/users'
import type { EffectExecutor, EffectOutcome } from '../effects/registry'
import { NO_TARGET } from '../sync-write/registry'
import { sessionCommandCtx } from './command-ctx'
import { type CreateInput, createSessionNow } from './command-plane'
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
export const SessionLaunchInput = sessionCommandPlaneInputs.create.omit({
  sessionId: true,
  mutationId: true,
  draftArtifacts: true,
})
export type SessionLaunchInput = z.infer<typeof SessionLaunchInput>

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
    const capability = userCommandPrincipal(asUserId(writer.id), writer.role).capability
    const ctx = await sessionCommandCtx(deps.modules(), capability, false, 'trpc')
    const parsed: CreateInput = sessionCommandPlaneInputs.create.parse({ ...input, sessionId })
    try {
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
    publish: (input) => ({
      ...(input.agentKind !== undefined ? { agentKind: input.agentKind } : {}),
      cwd: input.cwd,
      ...(input.machineId !== undefined ? { machineId: input.machineId } : {}),
      ...(input.issueId !== undefined ? { issueId: input.issueId } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      // Where its draft task goes (POD-6408): a device that reloads while the
      // launch waits paints the task's placeholder from this. Not a secret.
      ...(input.draftIssue !== undefined ? { draftIssue: input.draftIssue } : {}),
    }),
    ready: (_record, input) => reachable(input.machineId),
    run: async (ctx) => await run(ctx.record, ctx.input),
    recover: async (ctx) =>
      (await sessionExists(ctx.record.target.id))
        ? { status: 'succeeded', result: { sessionId: ctx.record.target.id } }
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

const refused = (message: string): EffectOutcome => ({
  status: 'failed',
  error: { code: 'refused', message },
})

/**
 * `sessions.create` through the effect path, as its caller: create the record,
 * wait for it to settle, answer the old shape (or throw the launch's own
 * refusal). `undefined` when nothing was submitted (no daemon to launch on now:
 * the route answers at once, as it always did).
 */
export async function createThroughLaunchEffect(
  modules: RegistryModules,
  principal: CommandPrincipal,
  launches: { errorOf(effectId: string): unknown },
  input: CreateInput,
): Promise<SessionSpawnResult | undefined> {
  const effects = modules.effects
  if (effects === undefined || principal.kind === 'system') return undefined
  if (
    input.machineId !== undefined
      ? !modules.machines.hasDaemon(input.machineId)
      : modules.machines.onlineMachineIds().length === 0
  ) {
    return undefined
  }
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
    // A shape the effect path refuses (a non-v4 id the old route accepted) is
    // the old route's to answer, as before.
    if (reply.refusal.kind === 'invalid' || reply.refusal.kind === 'unauthorized') return undefined
    if (cause !== undefined) throw cause
    throw new Error(`sessions.create was refused (${reply.refusal.kind})`)
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
