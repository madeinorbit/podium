/**
 * THE JOIN — the one conversation write contract (L1) paired with the
 * `MemoryReaderView` method that implements it (L3), per ADR 3 D1.
 *
 * The handler is the shipped method, unchanged. What this issue moves is where
 * the classification lives, not what the command does.
 */

import {
  type AnyCommandContract,
  CONVERSATION_CONTRACT_NAMES,
  CONVERSATION_CONTRACTS,
  type ConversationContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { MemoryReaderView } from '../memory/service'

/** A conversation handler is a method ON the service; everything it needs is
 *  already a constructor dependency. */
export type ConversationHandler<In, Out> = (svc: MemoryReaderView, input: In) => Out

export interface ConversationCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous by
  // construction; each entry's input type is pinned by its own contract through
  // the `satisfies` below and re-derived per command by the family's procedures.
  readonly handler: ConversationHandler<any, unknown>
}

export const CONVERSATION_COMMANDS_TRPC = {
  setMeta: {
    contract: CONVERSATION_CONTRACTS.setMeta,
    handler: ((svc, input) => svc.setConversationMeta(input)) satisfies ConversationHandler<
      z.infer<(typeof CONVERSATION_CONTRACTS)['setMeta']['input']>,
      unknown
    >,
  },
} as const satisfies Record<ConversationContractName, ConversationCommand>

export type ConversationCommandName = keyof typeof CONVERSATION_COMMANDS_TRPC

export const isConversationCommand = (name: string): name is ConversationCommandName =>
  Object.hasOwn(CONVERSATION_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed: an unknown name is `false`, so a typo removes a
 *  surface loudly instead of opening one silently. */
export function isConversationCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isConversationCommand(name)) return false
  return CONVERSATION_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const conversationCommandsOn = (transport: TransportTag): ConversationCommandName[] =>
  CONVERSATION_CONTRACT_NAMES.filter((n) => isConversationCommandExposedOn(n, transport))

/** The classification lint over the joined table — the same function the L1 test
 *  runs, so the gate cannot pass at L1 and be absent where the handler lives. */
export const conversationRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(CONVERSATION_COMMANDS_TRPC).map((c) => c.contract))
