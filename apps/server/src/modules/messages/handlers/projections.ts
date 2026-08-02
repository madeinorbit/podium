/**
 * Handlers for the three MESSAGE-ID projections — `mail.show`, `mail.status` and
 * `mail.dismiss` (POD-729).
 *
 * Moved VERBATIM out of `MessageGate`'s hand-written switch. Nothing about the
 * arithmetic changed and nothing was meant to: POD-727's characterization suite
 * drives the same `gate.dispatch` entry point and is the oracle for that claim.
 * What changed is that the input is now parsed by the CONTRACT's own schema and
 * the policy that governs each one is written down where a reader can audit it.
 *
 * `show` and `status` share a body on purpose — they are the same projection
 * under two names, kept apart because their CONTRACTS differ in intent (one
 * renders a message, one answers "what happened to mine") and collapsing the two
 * wire names would be a surface change, not a cutover.
 */

import type {
  ContractInput,
  mailDismissContract,
  mailShowContract,
  mailStatusContract,
} from '@podium/commands'
import type { MessageWire } from '../gate'
import type { MailHandlerContext } from './context'

/** The shared read: resolve, gate on `mayView`, project. */
function viewable(ctx: MailHandlerContext, id: string): MessageWire {
  const { caller, deps, access } = ctx
  const m = deps.messages.message(id)
  if (!m) throw new Error(`unknown message ${id}`)
  if (!access.mayView(caller.capability, m)) {
    throw new Error('not allowed to view a message you neither sent nor received')
  }
  return access.wire(m)
}

export function showHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailShowContract>,
): MessageWire {
  return viewable(ctx, input.id)
}

export function statusHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailStatusContract>,
): MessageWire {
  return viewable(ctx, input.id)
}

/**
 * STRICTER THAN `show`, deliberately — see the contract's rationale. `mayView`
 * admits the SENDER; dismiss must not, because clearing a row out of someone
 * else's mailbox is not a thing a sender may do to a recipient.
 */
export function dismissHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailDismissContract>,
): MessageWire {
  const { caller, deps, access } = ctx
  const svc = deps.messages
  const message = svc.message(input.id)
  if (!message) throw new Error(`unknown message ${input.id}`)
  if (caller.capability.scope.kind !== 'all' && !access.isRecipient(caller.capability, message)) {
    throw new Error('only the recipient of a message may dismiss it')
  }
  return access.wire(svc.dismiss(message.id, caller.capability.actorSessionId ?? null))
}
