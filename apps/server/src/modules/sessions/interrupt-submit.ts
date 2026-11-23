/** Submission adapter; imports no runtime executor or command composition. */
import { randomUUID } from 'node:crypto'
import { asMutationId, mintDeviceId, SESSION_INTERRUPT_KIND, type SessionId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { InterruptOutcome } from './inbox'
import type { SessionInterruptsHandle } from './session-interrupt-effect'

/** How long the old route waits for the stop to be asked for. */
export const SESSION_INTERRUPT_WAIT_MS = 15_000

/** The old route's refusal when no turn was running to stop. */
export const NO_TURN_RUNNING = 'no turn is running'

/**
 * `sessions.interrupt` through the effect path, as its caller (POD-6397):
 * create a `session.interrupt` record naming whatever turn runs now, and answer
 * the old shape once the stop has been asked for, or once the record ended
 * without one. It never interrupts directly (POD-6416): a refused record is
 * answered in the route's `{ ok: false, reason }` shape.
 */
export async function interruptThroughEffect(
  modules: RegistryModules,
  principal: CommandPrincipal,
  interrupts: SessionInterruptsHandle,
  input: { sessionId: SessionId; messageId?: string },
): Promise<InterruptOutcome> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('sessions.interrupt: no effects module is composed')
  if (principal.kind === 'system') return { ok: false, reason: 'unknown session' }
  const id = mintDeviceId('eff_')
  const { reply, cause } = await modules.syncWrite.submitDetailed(
    {
      mutationId: asMutationId(`mut_interrupt_${randomUUID()}`),
      command: 'effects.create',
      version: 1,
      input: {
        id,
        kind: SESSION_INTERRUPT_KIND,
        target: { kind: 'session', id: input.sessionId },
        input: input.messageId ? { messageId: input.messageId } : {},
      },
    },
    principal,
    'trpc',
  )
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) throw cause
    // The route's gate passed on this full id a moment ago: an unauthorized
    // answer now is a session gone out of reach, which reads as an unknown one.
    if (reply.refusal.kind === 'unauthorized' || reply.refusal.kind === 'target-not-found') {
      return { ok: false, reason: 'unknown session' }
    }
    return { ok: false, reason: `the interrupt was refused (${reply.refusal.kind})` }
  }
  // Answer once the stop was asked for, or once the record ended without one.
  const settled = effects.awaitSettled(id, SESSION_INTERRUPT_WAIT_MS)
  const first = await Promise.race([
    interrupts.requested(id).then((outcome) => ({ outcome })),
    settled.then((row) => ({ row })),
  ])
  if ('outcome' in first && first.outcome.ok) return first.outcome
  // A refusal: the record says whether the turn had ended meanwhile.
  const row = 'row' in first ? first.row : await settled
  if (row?.status === 'succeeded') {
    const result = row.result as { ended?: string; requested?: string } | null
    if (result?.ended === 'already') return { ok: false, reason: NO_TURN_RUNNING }
    return { ok: true, requested: (result?.requested as 'protocol' | undefined) ?? 'protocol' }
  }
  if (row?.status === 'failed') {
    return { ok: false, reason: row.error?.message ?? 'the interrupt failed' }
  }
  return { ok: false, reason: `the interrupt is ${row?.status ?? 'unknown'}` }
}
