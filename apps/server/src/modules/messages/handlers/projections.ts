/**
 * Handlers for the MESSAGE-ID projections — `mail.show`, `mail.status` and
 * `mail.dismiss` (POD-729), and the chat's by-id catch-up `mail.records`
 * (POD-4811).
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
  mailDismissNoticeContract,
  mailRecordsContract,
  mailShowContract,
  mailStatusContract,
} from '@podium/commands'
import { MAIL_VIEW_REFUSED } from '@podium/commands/mail-pointer-nudge'
import type { MessageRecordWire } from '@podium/model'
import type { MessageWire } from '../gate'
import { MailRefusal } from '../refusal'
import { type MailHandlerContext, mailWriter } from './context'

/** The shared read: resolve, gate on `mayView` (or on reading the session that
 *  sent it or that it was delivered to), project. */
async function viewable(ctx: MailHandlerContext, id: string): Promise<MessageWire> {
  const { caller, deps, access } = ctx
  const m = await deps.messages.message(id)
  if (!m) throw new Error(`unknown message ${id}`)
  if (!access.mayView(caller.capability, m) && !(await access.mayReadAsSessionReader(caller, m))) {
    throw new Error(MAIL_VIEW_REFUSED)
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
  if (!message) throw new MailRefusal('target-not-found', `unknown message ${input.id}`)
  if (caller.capability.scope.kind !== 'all' && !access.isRecipient(caller.capability, message)) {
    throw new MailRefusal('unauthorized', 'only the recipient of a message may dismiss it')
  }
  return await access.wire(
    await svc.dismiss(
      mailWriter(ctx, 'mail.dismiss'),
      message.id,
      caller.capability.actorSessionId ?? null,
    ),
  )
}

export async function cancelHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailCancelContract>,
): Promise<MessageWire> {
  const { caller, deps, access } = ctx
  const message = await deps.messages.message(input.id)
  if (!message) throw new MailRefusal('target-not-found', `unknown message ${input.id}`)
  if (!access.isSender(caller, message)) {
    throw new MailRefusal('unauthorized', 'only the sender of a message may cancel it')
  }
  return await access.wire(await deps.messages.cancel(mailWriter(ctx, 'mail.cancel'), message.id))
}

/** The sender dismisses the notice of a message that did not arrive (POD-4764). */
export async function dismissNoticeHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailDismissNoticeContract>,
): Promise<{ ok: true; dismissed: boolean }> {
  const { caller, deps, access } = ctx
  const message = await deps.messages.message(input.id)
  if (!message) throw new MailRefusal('target-not-found', `unknown message ${input.id}`)
  if (!access.isSender(caller, message)) {
    throw new MailRefusal('unauthorized', 'only the sender of a message may dismiss its notice')
  }
  return {
    ok: true,
    dismissed: await deps.messages.dismissNotice(mailWriter(ctx, 'mail.dismissNotice'), message.id),
  }
}

/**
 * A device's own chat messages, by id, in one read (POD-4811) — the records a
 * device that was away never saw on the feed. Answered for a PERSON only, by
 * the feed's own rule for kind `message` (`readMessageRecords`); an agent or
 * the system has no feed of chat records to catch up on.
 */
export async function recordsHandler(
  ctx: MailHandlerContext,
  input: ContractInput<typeof mailRecordsContract>,
): Promise<{ records: MessageRecordWire[] }> {
  const { principal } = ctx.caller
  if (principal.kind !== 'user') return { records: [] }
  return {
    records:
      'ids' in input
        ? await ctx.deps.messageRecords(principal.user, input.ids)
        : await ctx.deps.messageRecords(principal.user, input.transcriptItemIds, input.sessionId),
  }
}
