/**
 * THE JOIN — `interactions.answer`'s contract (L1, `@podium/commands`) paired
 * with the `InteractionService` method that implements it (L3), per ADR 3 D1.
 *
 * The same shape as `modules/approvals/registry.ts` and its siblings,
 * deliberately: the framework is built, and a family that invented its own join
 * would be a further answer to a question several families already answer
 * identically.
 */

import {
  type AnyCommandContract,
  INTERACTION_CONTRACT_NAMES,
  INTERACTION_CONTRACTS,
  type InteractionContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { InteractionAnswer } from '@podium/protocol'
import type { z } from 'zod'
import { type InboxPrincipalReference, SYSTEM_INBOX_PRINCIPAL } from '../sessions/inbox'
import type { InteractionService } from './service'

/** A handler is a method ON the service; the store, the delivery gate and the
 *  publisher are constructor dependencies already. */
export type InteractionHandler<In, Out> = (svc: InteractionService, input: In) => Out

export interface InteractionCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous by
  // construction; each entry's input type is pinned by its own contract through
  // the `satisfies` below.
  readonly handler: InteractionHandler<any, unknown>
}

/**
 * WHY THE DELIVERY PRINCIPAL IS THE SYSTEM ONE AND THE ATTRIBUTION IS NOT.
 *
 * `derivedFamilyProcedures` hands a handler `(service, input)` and no principal
 * — authorization has already happened, at the transport, against the contract's
 * classification. What the delivery path still needs is an inbox reference to
 * attribute the KEYSTROKES with, and that act is the server typing at a PTY on
 * the caller's behalf: `SYSTEM_INBOX_PRINCIPAL` is what every other server-driven
 * send uses for it.
 *
 * The answer's own accountability is a separate field and is not this:
 * `answeredBy: 'human'` records that a person decided, as against the policy
 * table's `'policy'`. Conflating the two — attributing the keystrokes to a user
 * whose identity this layer never received — would be a claim the transport did
 * not make.
 */
const DELIVERY_PRINCIPAL: InboxPrincipalReference = SYSTEM_INBOX_PRINCIPAL

export const INTERACTION_COMMANDS_TRPC = {
  answer: {
    contract: INTERACTION_CONTRACTS.answer,
    handler: ((svc, input) =>
      svc.answer({
        id: input.id,
        ...(input.text !== undefined ? { text: input.text } : {}),
        // The contract's typed arm is a passthrough object (L1 must not depend
        // on protocol for one field); the SERVICE checks its `kind` against the
        // row's before acting, which is the only place that pairing can be
        // verified against the actual ask.
        ...(input.answer !== undefined
          ? { answer: input.answer as unknown as InteractionAnswer }
          : {}),
        answeredBy: 'human' as const,
        principal: DELIVERY_PRINCIPAL,
      })) satisfies InteractionHandler<
      z.infer<(typeof INTERACTION_CONTRACTS)['answer']['input']>,
      unknown
    >,
  },
} as const satisfies Record<InteractionContractName, InteractionCommand>

export type InteractionCommandName = keyof typeof INTERACTION_COMMANDS_TRPC

export const isInteractionCommand = (name: string): name is InteractionCommandName =>
  Object.hasOwn(INTERACTION_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed: an unknown name is `false`, so a typo removes a
 *  surface loudly instead of opening one silently. */
export function isInteractionCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isInteractionCommand(name)) return false
  return INTERACTION_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

export const interactionCommandsOn = (transport: TransportTag): InteractionCommandName[] =>
  INTERACTION_CONTRACT_NAMES.filter((n) => isInteractionCommandExposedOn(n, transport))

/** The classification lint over the joined table — the same function the L1 test
 *  runs, so the gate cannot pass at L1 and be absent where the handler lives. */
export const interactionRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(INTERACTION_COMMANDS_TRPC).map((c) => c.contract))
