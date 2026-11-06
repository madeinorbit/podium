/**
 * MOVING A SESSION TO ANOTHER MACHINE IS AN EFFECT RECORD (POD-6422, ADR 12 D5;
 * decided on POD-6241).
 *
 * A handoff exports a live session on one daemon and imports it on another,
 * minutes apart, which has no place inside a request. So it is a one-off action
 * on the session: an effect record of kind `session.handoff`, created through
 * `effects.create`, whose target is the session and whose input is the machine
 * it moves to. Every device sees it pending, running ("moving") and how it ended.
 *
 *  - RUN: the handoff coordinator as it always was (`HandoffCoordinator`):
 *    admission and its single-flight, placement, the pre-flight and the
 *    transfer, with `use` checked on both machines and again at each apply
 *    point. The record only says who asked: the writer as they are NOW (an
 *    active account and its current role, or an agent's current capability).
 *    A refusal is `failed` with its message, and with the classified reason
 *    (`unauthorized`, `unreachable`, `unknown-target`) as the code when it has
 *    one, so the old routes rethrow the same refusal.
 *  - NO READY GATE, SHORT DEADLINE. The command is online-only: it runs at once
 *    and an offline machine is the coordinator's own refusal ("target machine is
 *    offline"). A record queued on a device that arrives later than
 *    {@link SESSION_HANDOFF_DEADLINE_MS} expires unrun, so a move is never
 *    replayed after the world has moved.
 *  - RECOVER (the server stopped mid-run): the row on the target machine is
 *    `succeeded`; still live on the source with no move painted is `failed`
 *    (nothing moved, or it rolled back); anything else is `unknown`, for a
 *    person to look at. Surviving a restart mid-transfer is deferred work: the
 *    transfer's arbitration lives in one process.
 *  - TARGET: a session that exists, for a person or an agent. Every right the
 *    move needs is checked by the coordinator when it runs, with the messages
 *    the route always gave.
 *  - THE OLD ROUTES: `sessions.handoff` over tRPC and the relay's `handoff` arm
 *    create the record as their caller and wait for it ({@link handoffThroughEffect}).
 */

import { randomUUID } from 'node:crypto'
import { sessionHandoffInput } from '@podium/commands'
import {
  asMutationId,
  asUserId,
  type EffectTarget,
  type HandoffRefusalReason,
  type MachineId,
  mintDeviceId,
  type SessionId,
  spawnedByParentSessionId,
} from '@podium/model'
import type { z } from 'zod'
import {
  type CommandPrincipal,
  resolvePrincipalAsync,
  userCommandPrincipal,
} from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { UsersRepository } from '../../store/users'
import type { EffectExecutor, EffectOutcome } from '../effects/registry'
import { NO_TARGET } from '../sync-write/registry'
import { HANDOFF_UNKNOWN_SESSION, type HandoffCaller, type HandoffResult } from './handoff/ports'
import { HandoffRefusalError, handoffRefusalOf } from './handoff/refusal'
import { NO_LONGER_ALLOWED } from './lifecycle-controller'

export const SESSION_HANDOFF_KIND = 'session.handoff'

/** A move that has not started by now is not the one its writer asked for. */
export const SESSION_HANDOFF_DEADLINE_MS = 2 * 60 * 1000

/** How long the old routes wait: a handoff may clone the repo on its target. */
export const SESSION_HANDOFF_WAIT_MS = 10 * 60 * 1000

/** The record's input: where the session goes (the session is the target). */
export const SessionHandoffEffectInput = sessionHandoffInput.pick({ machineId: true }).strict()
export type SessionHandoffEffectInput = z.infer<typeof SessionHandoffEffectInput>

const REFUSAL_REASONS: ReadonlySet<string> = new Set<HandoffRefusalReason>([
  'unauthorized',
  'unreachable',
  'unknown-target',
])

/** A run's thrown refusal, kept whole in the record: the classified reason
 *  when it has one, so {@link errorOfRecord} can rebuild the same error. */
function failedOf(error: unknown): EffectOutcome {
  const message = error instanceof Error ? error.message : String(error)
  return { status: 'failed', error: { code: handoffRefusalOf(error) ?? 'refused', message } }
}

/** The error the route always threw for a failed record. */
export function errorOfRecord(row: Pick<EffectRow, 'error'>): Error {
  const code = row.error?.code ?? 'refused'
  const message = row.error?.message ?? 'handoff failed'
  return REFUSAL_REASONS.has(code)
    ? new HandoffRefusalError(message, code as HandoffRefusalReason)
    : new Error(message)
}

export interface SessionHandoffEffectDeps {
  modules(): RegistryModules
  /** The writer's account as it is now. */
  users: Pick<UsersRepository, 'get'>
}

/** The writing agent, when an agent wrote it (`session:<id>`). */
const agentOf = (record: EffectRow): SessionId | undefined =>
  record.actor?.startsWith('session:')
    ? (record.actor.slice('session:'.length) as SessionId)
    : undefined

export function registerSessionHandoffEffect(deps: SessionHandoffEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('session handoff: no effects module')

  /**
   * The writer as they are NOW, as the coordinator's caller: a person's active
   * account and current role, or an agent's current capability (its session
   * gone, or its human's account disabled, and it may no longer ask).
   */
  const writerOf = async (record: EffectRow): Promise<HandoffCaller | undefined> => {
    if (record.createdBy === null) return undefined
    const user = await deps.users.get(record.createdBy)
    if (!user || user.disabledAt) return undefined
    const agent = agentOf(record)
    if (agent === undefined) {
      const principal = userCommandPrincipal(asUserId(user.id), user.role)
      return { capability: principal.capability, principal }
    }
    const sessions = deps.modules().sessions
    if (!(await sessions.sessionRowExists(agent))) return undefined
    const capability = await sessions.capabilityForSession(agent)
    const principal = await resolvePrincipalAsync(capability, {
      parentSessionOf: async (sessionId) =>
        spawnedByParentSessionId((await sessions.sessionById(sessionId))?.spawnedBy),
    })
    return principal.kind === 'system' ? undefined : { capability, principal }
  }

  const executor: EffectExecutor<SessionHandoffEffectInput> = {
    kind: SESSION_HANDOFF_KIND,
    // Its parsed form is the input type; zod's input form differs only by the
    // branded id it brands while parsing.
    input: SessionHandoffEffectInput as unknown as z.ZodType<SessionHandoffEffectInput>,
    deadlineMs: SESSION_HANDOFF_DEADLINE_MS,
    target: async (target: EffectTarget, principal: CommandPrincipal) => {
      if (principal.kind === 'system' || target.kind !== 'session') return undefined
      return (await deps.modules().sessions.sessionRowExists(target.id as SessionId))
        ? NO_TARGET
        : undefined
    },
    publish: (input) => ({ machineId: input.machineId }),
    run: async (ctx) => {
      const caller = await writerOf(ctx.record)
      if (caller === undefined) {
        return { status: 'failed', error: { code: 'refused', message: NO_LONGER_ALLOWED } }
      }
      await ctx.stage('moving')
      try {
        const result: HandoffResult = await deps
          .modules()
          .issueSessionLifecycle.handoffSession(
            { sessionId: ctx.record.target.id as SessionId, machineId: ctx.input.machineId },
            caller,
          )
        return { status: 'succeeded', result }
      } catch (error) {
        return failedOf(error)
      }
    },
    recover: async (ctx) => {
      const row = await deps.modules().sessions.sessionById(ctx.record.target.id as SessionId)
      if (row?.machineId === ctx.input.machineId) {
        return { status: 'succeeded', result: { ok: true, newCwd: row.cwd } }
      }
      if (row !== undefined && row.handoffTargetMachineId == null && row.status === 'live') {
        return {
          status: 'failed',
          error: {
            code: 'interrupted',
            message: 'The server stopped during the move; the session is still on its machine.',
          },
        }
      }
      return {
        status: 'unknown',
        error: {
          code: 'lost-track',
          message:
            'The server stopped during the move; check where the session is before moving it again.',
        },
      }
    },
  }
  effects.executors.register(executor)
}

/**
 * `sessions.handoff` through the effect path, as its caller (POD-6422): create a
 * `session.handoff` record, wait for it to settle, and answer the old shape or
 * throw the refusal the route always threw. It never moves a session itself.
 * LEGACY(remove-after: 2027-03): the route's callers are the CLI's
 * `podium session handoff` and apps older than the effect record.
 */
export async function handoffThroughEffect(
  modules: RegistryModules,
  principal: CommandPrincipal,
  input: { sessionId: SessionId; machineId: MachineId },
): Promise<HandoffResult> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('sessions.handoff: no effects module is composed')
  // The coordinator's own first refusal: no ambient operator.
  if (principal.kind === 'system') throw new Error('handoff requires an authenticated caller')
  const id = mintDeviceId('eff_')
  const { reply, cause } = await modules.syncWrite.submitDetailed(
    {
      mutationId: asMutationId(`mut_handoff_${randomUUID()}`),
      command: 'effects.create',
      version: 1,
      input: {
        id,
        kind: SESSION_HANDOFF_KIND,
        target: { kind: 'session', id: input.sessionId },
        input: { machineId: input.machineId },
      },
    },
    principal,
    // An agent reaches it over its daemon's relay; a person over tRPC.
    principal.kind === 'agent' ? 'relay' : 'trpc',
  )
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) throw cause
    // A session that does not exist, as the route's pinned throw.
    if (reply.refusal.kind === 'unauthorized' || reply.refusal.kind === 'target-not-found') {
      throw new Error(HANDOFF_UNKNOWN_SESSION)
    }
    throw new Error(`the handoff was refused (${reply.refusal.kind})`)
  }
  const settled = await effects.awaitSettled(id, SESSION_HANDOFF_WAIT_MS)
  if (settled?.status === 'succeeded') return settled.result as HandoffResult
  if (settled?.status === 'failed') throw errorOfRecord(settled)
  throw new Error(
    `the handoff is ${settled?.status ?? 'unknown'} as effect ${id}; it shows on the session`,
  )
}
