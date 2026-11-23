/** Submission adapter; the executor and command composition share this leaf. */
import { randomUUID } from 'node:crypto'
import { asMutationId, mintDeviceId, type SessionId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { ConfigureOutcome } from './runtime-gateway'

export const SESSION_CONFIGURE_KIND = 'session.configure'
/** How long the old route waits for its record to settle. */
export const SESSION_CONFIGURE_WAIT_MS = 30_000

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
