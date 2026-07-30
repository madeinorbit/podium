/**
 * THE JOIN — the three spec write contracts (L1, `@podium/commands`) paired with
 * the `SpecsService` methods that implement them (L3), per ADR 3 D1 and the
 * three-way split POD-311 established.
 *
 * POD-385 landed the contracts and repointed the SCHEMAS at them: `specsInputs`
 * already holds `specsCreateInput`, `specsSaveInput` and `specsRemoveInput` by
 * identity, so the tRPC slice, the relay and the contract table validate through
 * one definition. What it deliberately did NOT do — its scope was the L1
 * declaration — is make the tRPC arm follow from the table. That is POD-386's
 * cutover, and this file is its first half.
 *
 * WHY A JOIN TABLE AND NOT THREE `t.procedure` LINES. The contract carries the
 * classification (`owned-compute`, `machineVerb: 'use'`, `confirmation: 'confirm'`
 * on `remove` alone) and the exposure list. A hand-written procedure beside it is
 * a second answer to "who may run this, and where is it served" — the exact
 * duplication the 3.3 split set out to end. Here the transport reaches a CONTRACT
 * by name; the contract's schema validates; only then does the joined method run.
 *
 * THE HANDLER IS UNCHANGED. Every entry below forwards to the same
 * `SpecsService` method the router called by hand, with the same repo-root gate
 * inside it. "Behaviour identical" is the acceptance criterion, so nothing about
 * validation, authorization or error mapping moves with the dispatch.
 */

import {
  type AnyCommandContract,
  registryClassificationErrors,
  SPEC_CONTRACT_NAMES,
  SPEC_CONTRACTS,
  type SpecContractName,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { SpecsService } from './service'

/**
 * A spec handler is a method ON the service and takes nothing else — no ports
 * object, unlike the fleet family, because everything a spec write needs (the
 * repo-root allowlist) is already a constructor dependency of `SpecsService`.
 */
export type SpecHandler<In, Out> = (svc: SpecsService, input: In) => Out

/** One contract joined to the service method that implements it. */
export interface SpecCommand {
  readonly contract: AnyCommandContract
  // biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous by
  // construction; each entry's input type is pinned by its own contract and
  // re-derived per command by `SpecProcedures`, and `never` here would make the
  // table untypeable rather than safer.
  readonly handler: SpecHandler<any, unknown>
}

/**
 * The joined table, keyed by the BARE proc name — the workflow table's key shape
 * rather than the fleet table's dotted one, because all three of these live on
 * the single `specs` router and there is no sibling family to collide with.
 *
 * `save` is the wire name; the CLI verb is `update`. The mapping is
 * `SPEC_COMMANDS`' business (`@podium/issue-client`) and is deliberately not
 * restated here — a second copy of that alias is how the two names drift.
 */
export const SPEC_COMMANDS_TRPC = {
  create: {
    contract: SPEC_CONTRACTS.create,
    handler: ((svc, input) => svc.create(input)) satisfies SpecHandler<
      z.infer<typeof SPEC_CONTRACTS.create.input>,
      unknown
    >,
  },
  save: {
    contract: SPEC_CONTRACTS.save,
    handler: ((svc, input) => svc.save(input)) satisfies SpecHandler<
      z.infer<typeof SPEC_CONTRACTS.save.input>,
      unknown
    >,
  },
  remove: {
    contract: SPEC_CONTRACTS.remove,
    handler: ((svc, input) => svc.remove(input)) satisfies SpecHandler<
      z.infer<typeof SPEC_CONTRACTS.remove.input>,
      unknown
    >,
  },
} as const satisfies Record<SpecContractName, SpecCommand>

export type SpecCommandName = keyof typeof SPEC_COMMANDS_TRPC

export const isSpecCommand = (name: string): name is SpecCommandName =>
  Object.hasOwn(SPEC_COMMANDS_TRPC, name)

/**
 * ADR 3 D3, enforced rather than documented. Default-closed: an unknown name is
 * `false`, not "probably fine", so a typo at a call site removes a surface
 * loudly instead of opening one silently.
 */
export function isSpecCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isSpecCommand(name)) return false
  return SPEC_COMMANDS_TRPC[name].contract.exposure.includes(transport)
}

/** The proc names this family serves on `transport`, in the contract table's
 *  sorted order so a consumer's iteration does not depend on declaration order. */
export const specCommandsOn = (transport: TransportTag): SpecCommandName[] =>
  SPEC_CONTRACT_NAMES.filter((n) => isSpecCommandExposedOn(n, transport))

/** The classification lint over the joined table — the same function the L1 test
 *  runs, so the gate cannot pass at L1 and be absent where the handlers live. */
export const specRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(SPEC_COMMANDS_TRPC).map((c) => c.contract))
