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
  mailAskContract,
  mailDismissContract,
  mailInboxConsumeContract,
  mailLedgerContract,
  mailPendingRemindersContract,
  mailReplyContract,
  mailSendContract,
  mailShowContract,
  mailStatusContract,
  registryClassificationErrors,
  spawnAgentContract,
  type TransportTag,
} from '@podium/commands'
import { askHandler } from './handlers/ask'
import { awaitAgentHandler } from './handlers/await-agent'
import type { MailHandlerContext } from './handlers/context'
import { inboxConsumeHandler } from './handlers/inbox-consume'
import { ledgerHandler } from './handlers/ledger'
import { pendingRemindersHandler } from './handlers/pending-reminders'
import { dismissHandler, showHandler, statusHandler } from './handlers/projections'
import { replyHandler } from './handlers/reply'
import { sendHandler } from './handlers/send'
import { spawnAgentHandler } from './handlers/spawn-agent'

/** One contract joined to the handler that implements it. */
export interface MailCommand {
  readonly contract: AnyCommandContract
  readonly handler: (ctx: MailHandlerContext, input: never) => unknown
}

/**
 * The joined table, keyed by the BARE proc name every transport dispatches on
 * (`send`, `inbox`, …) — the shipped wire names, kept: renaming the wire is a
 * client-compatibility change and this issue is a cutover, not a rename. The
 * contract's own dotted name (`mail.send`) is the identity the audit and the
 * classification lint read.
 *
 * COMPLETE AS OF POD-729. Every proc `MessageGate` ever served is in this table;
 * the switch it used to fall through to is gone. That is what makes "one authz
 * path, not one per transport" a structural fact rather than a convention — the
 * relay arm and the tRPC arm both arrive here, and there is no second place left
 * to arrive.
 */
export const MAIL_COMMANDS = {
  send: { contract: mailSendContract, handler: sendHandler },
  reply: { contract: mailReplyContract, handler: replyHandler },
  spawnAgent: { contract: spawnAgentContract, handler: spawnAgentHandler },
  awaitAgent: { contract: awaitAgentContract, handler: awaitAgentHandler },
  inbox: { contract: mailInboxConsumeContract, handler: inboxConsumeHandler },
  ledger: { contract: mailLedgerContract, handler: ledgerHandler },
  show: { contract: mailShowContract, handler: showHandler },
  dismiss: { contract: mailDismissContract, handler: dismissHandler },
  status: { contract: mailStatusContract, handler: statusHandler },
  pendingReminders: {
    contract: mailPendingRemindersContract,
    handler: pendingRemindersHandler,
  },
  ask: { contract: mailAskContract, handler: askHandler },
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

/**
 * ADR 3 D3, enforced rather than documented: a transport may only serve a
 * command whose `exposure` names it. Default-closed — an unknown proc name is
 * `false`, not "probably fine" — so a typo at a call site removes a surface
 * loudly instead of opening one silently.
 */
export function isMailProcExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isMailProc(proc)) return false
  return MAIL_COMMANDS[proc].contract.exposure.includes(transport)
}

/** The classification lint over the joined table — see the registry test. */
export const mailRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(MAIL_COMMANDS).map((c) => c.contract))
