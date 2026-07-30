/**
 * THE JOIN — contracts (L1, `@podium/commands`) paired with handlers (L3, this
 * module's `handlers/` directory), per ADR 3 D1 and POD-311's three-way split.
 *
 * The table below is the whole seam. A transport does not reach a handler; it
 * reaches a contract by name, the contract's schema validates the input, and the
 * joined handler runs. That is what makes "one authz path, not one per
 * transport" a structural fact: the daemon relay arm and the tRPC arm both
 * arrive here, and there is no second place to arrive.
 *
 * POD-729 derives the tRPC/CLI/MCP/relay surfaces from `exposure` and deletes the
 * hand-written procs; this issue lands the pairs and routes the shipped gate
 * through them.
 */

import {
  type AnyCommandContract,
  awaitAgentContract,
  mailInboxConsumeContract,
  mailLedgerContract,
  mailReplyContract,
  mailSendContract,
  registryClassificationErrors,
  spawnAgentContract,
} from '@podium/commands'
import { awaitAgentHandler } from './handlers/await-agent'
import type { MailHandlerContext } from './handlers/context'
import { inboxConsumeHandler } from './handlers/inbox-consume'
import { ledgerHandler } from './handlers/ledger'
import { replyHandler } from './handlers/reply'
import { sendHandler } from './handlers/send'
import { spawnAgentHandler } from './handlers/spawn-agent'

/** One contract joined to the handler that implements it. */
export interface MailCommand {
  readonly contract: AnyCommandContract
  readonly handler: (ctx: MailHandlerContext, input: never) => unknown
}

/**
 * The joined table, keyed by the BARE proc name the shipped gate dispatches on
 * (`send`, `inbox`, …) so the relay's existing wire names keep working through
 * the cutover. The contract's own dotted name (`mail.send`) is the wire name
 * POD-729 moves to.
 */
export const MAIL_COMMANDS = {
  send: { contract: mailSendContract, handler: sendHandler },
  reply: { contract: mailReplyContract, handler: replyHandler },
  spawnAgent: { contract: spawnAgentContract, handler: spawnAgentHandler },
  awaitAgent: { contract: awaitAgentContract, handler: awaitAgentHandler },
  inbox: { contract: mailInboxConsumeContract, handler: inboxConsumeHandler },
  ledger: { contract: mailLedgerContract, handler: ledgerHandler },
} as const satisfies Record<string, MailCommand>

export type MailProcName = keyof typeof MAIL_COMMANDS

export const isMailProc = (proc: string): proc is MailProcName => proc in MAIL_COMMANDS

/**
 * Validate through the CONTRACT's schema, then run the joined handler. The
 * schema is the single validation source for every transport (ADR 3 D1) — a
 * transport that wanted its own parse would be a second validation surface, and
 * the two would drift.
 */
export function dispatchMailCommand(
  proc: MailProcName,
  ctx: MailHandlerContext,
  rawInput: unknown,
): Promise<unknown> | unknown {
  const { contract, handler } = MAIL_COMMANDS[proc]
  const input = contract.input.parse(rawInput)
  return (handler as (c: MailHandlerContext, i: unknown) => unknown)(ctx, input)
}

/** The classification lint over the joined table — see the registry test. */
export const mailRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(MAIL_COMMANDS).map((c) => c.contract))
