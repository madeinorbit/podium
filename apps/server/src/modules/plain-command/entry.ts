/**
 * THE PLAIN COMMAND PATH (ADR 12 D8, POD-6360).
 *
 * About 26 commands have no synced effect: sign-in, accounts, setup, secrets and
 * the Telegram setup, logs, telemetry, performance reports, model refresh. They do
 * not go through the sync write entry point, and they do not need to: nothing
 * they write reaches a device's replica, so there is no receipt to give and
 * nothing for an outbox to confirm.
 *
 * What they DO share with every other command is the front door (`front-door.ts`):
 * the principal from the transport, the coarse permission check before the input
 * is looked at, then the parse. After that comes a plain handler, and the
 * handler is all this path adds:
 *
 *  - ONLINE ONLY. A contract whose delivery class lets a client queue it, or
 *    whose exposure includes the outbox, is refused when its family is built
 *    ({@link assertPlainContract}). A plain command is never queued and never
 *    stored on a device.
 *  - NO AUTHORITY. The handler runs inside the plain command scope
 *    (`plain-command-scope.ts`), and the write-seam Ledger refuses every commit and
 *    capture made there. A plain handler cannot write synced data, even by
 *    accident.
 *  - NO DEDUP LEDGER. Nothing here records a result, because a result may hold
 *    a secret. This path is built without a `MutationLedger`, a ledger or a unit of
 *    work: there is nothing in it that could store one.
 *
 * Nothing more is prescribed. Each of these commands is a special security or
 * diagnostics flow and keeps its own rules (redaction, audit trail) in its family.
 */

import type { AnyCommandContract, CommandDef } from '@podium/commands'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { withPlainCommand } from '../../plain-command-scope'
import {
  coarselyPermitted,
  contractFrontDoor,
  defFrontDoor,
  type FrontDoorCommand,
  type FrontDoorTransport,
  parseCommandInput,
} from '../front-door'

/** Why the front door turned a plain command away. */
export type PlainCommandRefusal =
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'invalid'; readonly details: string[]; readonly error: z.ZodError }

export type PlainCommandReply<Out> =
  | { readonly outcome: 'applied'; readonly result: Out }
  | { readonly outcome: 'rejected'; readonly refusal: PlainCommandRefusal }

export interface PlainCommandCall<Out> {
  readonly contract: AnyCommandContract
  readonly principal: CommandPrincipal
  readonly transport: FrontDoorTransport
  /** The input as the transport received it, unparsed. */
  readonly input: unknown
  /** The command's target check, after the parse; absent when the coarse check
   *  is the whole answer. A refusal here is `unauthorized`, like the coarse one. */
  readonly targetPermitted?: PlainTargetCheck | undefined
  /** The plain handler, given the parsed input. */
  readonly run: (input: unknown) => Out | Promise<Out>
}

/**
 * Step 4, for a command whose rows belong to someone: may THIS principal touch the
 * target this input names? The role floor (step 2) says which commands a principal
 * may attempt; it never decides whose rows (ADR 3 Amendment 1 D15). Declared on the
 * command's table entry, next to its handler.
 */
export type PlainTargetCheck = (principal: CommandPrincipal, input: unknown) => boolean

/**
 * Run one plain command: coarse check, parse, the command's target check, then the
 * handler inside the plain scope. A refusal is a reply; a handler's throw propagates unchanged.
 */
export async function runPlainCommand<Out>(
  call: PlainCommandCall<Out>,
): Promise<PlainCommandReply<Awaited<Out>>> {
  const { contract } = call
  return await runThroughFrontDoor(
    contract.name,
    contractFrontDoor(contract),
    contract.input,
    call,
  )
}

/**
 * A plain command declared as a `defineCommands` entry rather than a contract
 * (the lock registry, POD-6419): the same front door, read through the def's own
 * fields (`defFrontDoor`: the member floor, its action, its exposure), then the
 * plain handler.
 */
export interface PlainDefCall<Out> extends Omit<PlainCommandCall<Out>, 'contract'> {
  /** The dotted wire name, `namespace.key`: the def carries none of its own. */
  readonly name: string
  readonly def: CommandDef
}

export async function runPlainDef<Out>(
  call: PlainDefCall<Out>,
): Promise<PlainCommandReply<Awaited<Out>>> {
  return await runThroughFrontDoor(call.name, defFrontDoor(call.def), call.def.input, call)
}

async function runThroughFrontDoor<Out>(
  name: string,
  door: FrontDoorCommand,
  schema: z.ZodTypeAny,
  call: Omit<PlainCommandCall<Out>, 'contract'>,
): Promise<PlainCommandReply<Awaited<Out>>> {
  if (!coarselyPermitted(door, call.principal, call.transport)) {
    return { outcome: 'rejected', refusal: { kind: 'unauthorized' } }
  }
  const parsed = parseCommandInput(schema, call.input)
  if (!parsed.ok) {
    return {
      outcome: 'rejected',
      refusal: { kind: 'invalid', details: parsed.details, error: parsed.error },
    }
  }
  if (call.targetPermitted && !call.targetPermitted(call.principal, parsed.input)) {
    return { outcome: 'rejected', refusal: { kind: 'unauthorized' } }
  }
  const result = await withPlainCommand(name, async () => await call.run(parsed.input))
  return { outcome: 'applied', result }
}

/**
 * A plain command is online only (ADR 12 D8). Checked when a family is built, so a
 * contract that a client could queue fails at composition, before anybody relies
 * on it, rather than at the first drain.
 */
export function assertPlainContract(contract: AnyCommandContract): void {
  const delivery = contract.delivery.class
  if (delivery !== 'online-only' && delivery !== 'online-sensitive') {
    throw new Error(
      `${contract.name} is served on the plain path but its delivery class is '${delivery}': a plain command is online only`,
    )
  }
  if (contract.exposure.includes('outbox')) {
    throw new Error(
      `${contract.name} is served on the plain path but is exposed on the outbox: a plain command is never queued`,
    )
  }
}
