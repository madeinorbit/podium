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
  mailCancelContract,
  mailDismissContract,
  mailShowContract,
  mailStatusContract,
} from '@podium/commands'
import type { MessageWire } from '../gate'
import type { MailHandlerContext } from './context'

/** The shared read: resolve, gate on `mayView`, project. */
async function viewable(ctx: MailHandlerContext, id: string): Promise<MessageWire> {
  const { caller, deps, access } = ctx
  const m = await deps.messages.message(id)
  if (!m) throw new Error(`unknown message ${id}`)
  if (!access.mayView(caller.capability, m)) {
    throw new Error('not allowed to view a message you neither sent nor received')
  }
  return await access.wire(m)
}

export async function showHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailShowContract>,
): Promise<MessageWire> {
  return await viewable(ctx, input.id)
}

export async function statusHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailStatusContract>,
): Promise<MessageWire> {
  return await viewable(ctx, input.id)
}

/**
 * STRICTER THAN `show`, deliberately — see the contract's rationale. `mayView`
 * admits the SENDER; dismiss must not, because clearing a row out of someone
 * else's mailbox is not a thing a sender may do to a recipient.
 */
export async function dismissHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailDismissContract>,
): Promise<MessageWire> {
  const { caller, deps, access } = ctx
  const svc = deps.messages
  const message = await svc.message(input.id)
  if (!message) throw new Error(`unknown message ${input.id}`)
  if (caller.capability.scope.kind !== 'all' && !access.isRecipient(caller.capability, message)) {
    throw new Error('only the recipient of a message may dismiss it')
  }
  return await access.wire(await svc.dismiss(message.id, caller.capability.actorSessionId ?? null))
}

export async function cancelHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailCancelContract>,
): Promise<MessageWire> {
  const { caller, deps, access } = ctx
  const message = await deps.messages.message(input.id)
  if (!message) throw new Error(`unknown message ${input.id}`)
  if (!access.isSender(caller, message)) {
    throw new Error('only the sender of a message may cancel it')
  }
  return await access.wire(await deps.messages.cancel(message.id))
}
