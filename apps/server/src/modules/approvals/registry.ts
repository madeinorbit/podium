/**
 * THE JOIN — the two approval decision contracts (L1, `@podium/commands`) paired
 * with the `ApprovalService` methods that implement them (L3), per ADR 3 D1 and
 * the three-way split POD-311 established.
 *
 * The same shape as `modules/settings/registry.ts`, `modules/specs/registry.ts`
 * and `modules/fleet/registry.ts`, deliberately: the framework is built, and a
 * family that invented its own join would be a further answer to a question four
 * families already answer identically.
 *
 * THE HANDLERS ARE UNCHANGED. `approve` and `deny` are the shipped service methods
 * byte-for-byte — the state-machine transition, the event log, the notify and the
 * broadcast all stay where they are. What this issue moves is WHO DECIDES THAT
 * THEY MAY RUN: it was a hand-written `.mutation(` in `router.ts` whose only gate
 * was "you reached /trpc", and it is now the contract's classification read by the
 * derived transport.
 */

import {
  type AnyCommandContract,
  APPROVAL_CONTRACT_NAMES,
  APPROVAL_CONTRACTS,
  type ApprovalContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { ApprovalService } from './service'

/** An approval handler is a method ON the service; everything it needs (the store,
 *  the machine channel, the event log, the notifier) is a constructor dependency
 *  already. */
export type ApprovalHandler<In, Out> = (svc: ApprovalService, input: In) => Out

/** One contract joined to the service method that implements it. */
export interface ApprovalCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous by
  // construction; each entry's input type is pinned by its own contract through
  // the `satisfies` below, and re-derived per command by `ApprovalProcedures`.
  readonly handler: ApprovalHandler<any, unknown>
}

/** The joined table, keyed by the BARE proc name the `approvals` router serves —
 *  the spec table's shape rather than the settings table's dotted one, because
 *  these two are named `approve`/`deny` on the wire and the router key is what
 *  the census and the running router both anchor on. */
export const APPROVAL_COMMANDS_TRPC = {
  approve: {
    contract: APPROVAL_CONTRACTS.approve,
    handler: ((svc, input) => svc.approve(input.id)) satisfies ApprovalHandler<
      z.infer<(typeof APPROVAL_CONTRACTS)['approve']['input']>,
      unknown
    >,
  },
  deny: {
    contract: APPROVAL_CONTRACTS.deny,
    handler: ((svc, input) => svc.deny(input.id)) satisfies ApprovalHandler<
      z.infer<(typeof APPROVAL_CONTRACTS)['deny']['input']>,
      unknown
    >,
  },
} as const satisfies Record<ApprovalContractName, ApprovalCommand>

export type ApprovalCommandName = keyof typeof APPROVAL_COMMANDS_TRPC

export const isApprovalCommand = (name: string): name is ApprovalCommandName =>
  Object.hasOwn(APPROVAL_COMMANDS_TRPC, name)

/**
 * ADR 3 D3, enforced rather than documented. Default-closed: an unknown name is
 * `false`, so a typo at a call site removes a surface loudly instead of opening
 * one silently.
 */
export function isApprovalCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isApprovalCommand(name)) return false
  return APPROVAL_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

/** The commands this family serves on `transport`, in the contract table's sorted
 *  order so a consumer's iteration does not depend on declaration order. */
export const approvalCommandsOn = (transport: TransportTag): ApprovalCommandName[] =>
  APPROVAL_CONTRACT_NAMES.filter((n) => isApprovalCommandExposedOn(n, transport))

/** The classification lint over the joined table — the same function the L1 test
 *  runs, so the gate cannot pass at L1 and be absent where the handlers live. */
export const approvalRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(APPROVAL_COMMANDS_TRPC).map((c) => c.contract))
