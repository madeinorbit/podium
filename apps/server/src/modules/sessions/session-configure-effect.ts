/**
 * CHANGING A RUNNING SESSION'S MODEL OR EFFORT IS AN EFFECT RECORD (POD-6416,
 * ADR 12 D5 E2; decided on POD-6359).
 *
 * `sessions.configure` asks the session's DRIVER for the change (POD-3081), and
 * only the driver's grant writes the requested model onto the session row. A
 * round trip to a machine has no place inside a request, so the change is a
 * one-off action on the session: an effect record of kind `session.configure`,
 * its target the session, its input the patch (`model`, `effort`, at least one).
 *
 *  - RUN: asks the driver once, through the same `configureSession` the route
 *    called. A grant writes the row there and is `succeeded` with the driver's
 *    answer (`{ ok: true, effective }`); a refusal is `failed` with its typed
 *    reason as the code and the refusal itself as the result, so the old route
 *    answers it unchanged.
 *  - DEADLINE: short ({@link SESSION_CONFIGURE_DEADLINE_MS}). A change applied
 *    later would land on a different turn than the one the person chose it for
 *    (the contract's "direct-only, never queued"), so a record that cannot
 *    start soon expires unrun.
 *  - RECOVER (the server stopped mid-run): the row already shows the patch →
 *    `succeeded`; it does not → `failed`, safe to say because asking again is
 *    harmless and nothing on the row claims a change the driver did not grant.
 *  - THE OLD ROUTE: `sessions.configure` creates the record through
 *    `sync.submit` as its caller and waits for it to settle, answering its old
 *    shape (POD-6416 LEGACY adapter).
 */

import { randomUUID } from 'node:crypto'
import {
  asMutationId,
  type EffectTarget,
  mintDeviceId,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { EffectExecutor, EffectOutcome, EffectRunContext } from '../effects/registry'
import { NO_TARGET } from '../sync-write/registry'
import { sessionCommandCtx } from './command-ctx'
import type { ConfigureOutcome } from './runtime-gateway'

export const SESSION_CONFIGURE_KIND = 'session.configure'

/** A change that has not started by now would land on a later turn: unrun. */
export const SESSION_CONFIGURE_DEADLINE_MS = 60_000

/** How long the old route waits for its record to settle. */
export const SESSION_CONFIGURE_WAIT_MS = 30_000

/** The patch, as the contract states it (`sessions.configure` without the id). */
export const SessionConfigureInput = z
  .object({
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(64).optional(),
  })
  .refine((value) => value.model !== undefined || value.effort !== undefined, {
    message: 'name a model or an effort to change',
  })
export type SessionConfigureInput = z.infer<typeof SessionConfigureInput>

export interface SessionConfigureEffectDeps {
  modules(): RegistryModules
}

/** Does the session row already show this patch? */
function showsPatch(session: SessionMeta | undefined, input: SessionConfigureInput): boolean {
  if (session === undefined) return false
  const model = input.model?.trim() || undefined
  const effort = input.effort?.trim() || undefined
  return (
    (model === undefined || session.requestedModel === model) &&
    (effort === undefined || session.requestedEffort === effort)
  )
}

export function registerSessionConfigureEffect(deps: SessionConfigureEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('session configure: no effects module')

  const run = async (ctx: EffectRunContext<SessionConfigureInput>): Promise<EffectOutcome> => {
    const sessionId = ctx.record.target.id as SessionId
    const outcome: ConfigureOutcome = await deps.modules().sessions.configureSession({
      sessionId,
      ...(ctx.input.model !== undefined ? { model: ctx.input.model } : {}),
      ...(ctx.input.effort !== undefined ? { effort: ctx.input.effort } : {}),
    })
    if ('ok' in outcome) return { status: 'succeeded', result: outcome }
    const detail = 'detail' in outcome ? outcome.detail : undefined
    return {
      status: 'failed',
      error: { code: outcome.reason, message: detail ?? outcome.reason },
      result: outcome,
    }
  }

  const executor: EffectExecutor<SessionConfigureInput> = {
    kind: SESSION_CONFIGURE_KIND,
    // Its parsed form is the input type; the refinement only narrows.
    input: SessionConfigureInput as unknown as z.ZodType<SessionConfigureInput>,
    deadlineMs: SESSION_CONFIGURE_DEADLINE_MS,
    /** A session this caller may configure (`sessions.configure`), by its full id. */
    target: async (target: EffectTarget, principal: CommandPrincipal) => {
      if (principal.kind === 'system' || target.kind !== 'session') return undefined
      const plane = await sessionCommandCtx(deps.modules(), principal.capability, false, 'trpc')
      try {
        const row = await plane.target(target.id as SessionId, 'sessions.configure')
        return row?.sessionId === target.id ? NO_TARGET : undefined
      } catch {
        return undefined
      }
    },
    run,
    recover: async (ctx) =>
      showsPatch(
        await deps.modules().sessions.sessionById(ctx.record.target.id as SessionId),
        ctx.input,
      )
        ? { status: 'succeeded', result: { ok: true, effective: 'next-turn' } }
        : {
            status: 'failed',
            error: {
              code: 'interrupted',
              message: 'The server restarted before the change was confirmed; nothing changed.',
            },
          },
  }
  effects.executors.register(executor)
}

/**
 * `sessions.configure` through the effect path, as its caller (POD-6416): create
 * a `session.configure` record and answer the old shape once it settles. It
 * never asks the driver itself.
 */
export async function configureThroughEffect(
  modules: RegistryModules,
  principal: CommandPrincipal,
  input: { sessionId: SessionId; model?: string; effort?: string },
): Promise<ConfigureOutcome> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('sessions.configure: no effects module is composed')
  const unknown: ConfigureOutcome = { reason: 'not_running', detail: 'unknown session' }
  if (principal.kind === 'system') return unknown
  const id = mintDeviceId('eff_')
  const { reply, cause } = await modules.syncWrite.submitDetailed(
    {
      mutationId: asMutationId(`mut_configure_${randomUUID()}`),
      command: 'effects.create',
      version: 1,
      input: {
        id,
        kind: SESSION_CONFIGURE_KIND,
        target: { kind: 'session', id: input.sessionId },
        input: {
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.effort !== undefined ? { effort: input.effort } : {}),
        },
      },
    },
    principal,
    'trpc',
  )
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) throw cause
    // The route's gate passed on this full id a moment ago: a refusal on the
    // target now is a session gone out of reach, which reads as an unknown one.
    if (reply.refusal.kind === 'unauthorized' || reply.refusal.kind === 'target-not-found') {
      return unknown
    }
    return { reason: 'not_running', detail: `the change was refused (${reply.refusal.kind})` }
  }
  const row = await effects.awaitSettled(id, SESSION_CONFIGURE_WAIT_MS)
  if (row?.status === 'succeeded' || row?.status === 'failed') {
    const result = row.result as ConfigureOutcome | null
    if (result !== null && typeof result === 'object' && ('ok' in result || 'reason' in result)) {
      return result
    }
    if (row.status === 'failed') {
      return { reason: 'not_running', detail: row.error?.message ?? 'the change failed' }
    }
  }
  return {
    reason: 'not_running',
    detail: `the change is ${row?.status ?? 'still pending'}; it was not confirmed in time`,
  }
}
