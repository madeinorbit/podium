/**
 * THE JOIN — the four automation contracts (L1, `@podium/commands`) paired with
 * the handlers that implement them (L3, beside the service), per ADR 3 D1 and
 * POD-311's three-way split.
 *
 * A transport does not reach a handler; it reaches a CONTRACT by name, the
 * contract's schema validates the input, the contract's `exposure` decides whether
 * this transport serves it at all, and only then does the joined handler run. A
 * fifth automation command added to this table gets its validation and its
 * exposure decision because it DECLARED them, not because whoever added it
 * remembered to write them out beside a procedure.
 *
 * THE HANDLERS ARE THIN ON PURPOSE. `AutomationsService` is unchanged by POD-735
 * and every rule it enforces — schedule validation, the re-arm, the completed
 * one-off guard, the run-row cascade on remove — stays exactly where it was. What
 * moved is the input vocabulary and the classification; this file is the seam
 * where the two meet, and a handler that did more than adapt an argument list
 * would be a second place the rules could be stated.
 */

import {
  type AnyCommandContract,
  AUTOMATION_CONTRACTS,
  type AutomationContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { AutomationsService } from './service'

/** One contract joined to the handler that implements it. */
export interface AutomationCommand {
  readonly contract: AnyCommandContract
  /**
   * The table is heterogeneous by construction: each entry's input type is pinned
   * by its own contract and checked where the handler is declared, so `never` here
   * would make the table untypeable rather than safer.
   */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous table — see above
  readonly handler: (
    service: AutomationsService,
    input: any,
    principal: CommandPrincipal,
  ) => unknown
}

/**
 * The joined table, keyed by the BARE proc name the wire already dispatches on —
 * all four live on the one `automations` router, so unlike the fleet table there
 * is no prefix to disambiguate.
 *
 * `list` and `runs` are NOT here and are not contracts: a `visibility` class
 * describes what a command WRITES and a read writes nothing. They stay hand-written
 * queries in `router.ts`, and `AUTOMATION_QUERY_NAMES` names them so the cutover
 * audit's totality check knows they are declared rather than stray.
 */
export const AUTOMATION_COMMANDS = {
  create: {
    contract: AUTOMATION_CONTRACTS.create,
    handler: (service, input: z.infer<typeof AUTOMATION_CONTRACTS.create.input>, principal) =>
      service.create(input, principal),
  },
  update: {
    contract: AUTOMATION_CONTRACTS.update,
    handler: (service, input: z.infer<typeof AUTOMATION_CONTRACTS.update.input>, principal) =>
      service.update(input.id, input.patch, principal),
  },
  setEnabled: {
    contract: AUTOMATION_CONTRACTS.setEnabled,
    handler: (service, input: z.infer<typeof AUTOMATION_CONTRACTS.setEnabled.input>, principal) =>
      service.setEnabled(input.id, input.enabled, principal),
  },
  remove: {
    contract: AUTOMATION_CONTRACTS.remove,
    handler: (service, input: z.infer<typeof AUTOMATION_CONTRACTS.remove.input>, principal) =>
      service.remove(input.id, principal),
  },
} as const satisfies Record<AutomationContractName, AutomationCommand>

export type AutomationProcName = keyof typeof AUTOMATION_COMMANDS

export const isAutomationCommand = (proc: string): proc is AutomationProcName =>
  Object.hasOwn(AUTOMATION_COMMANDS, proc)

/**
 * ADR 3 D3, enforced rather than documented. Default-closed: an unknown proc is
 * `false`, not "probably fine", so a typo at a call site removes a surface loudly
 * instead of opening one silently.
 */
export function isAutomationCommandExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isAutomationCommand(proc)) return false
  return AUTOMATION_COMMANDS[proc].contract.exposure.includes(transport)
}

/** The classification lint over the JOINED table — the same function the L1 test
 *  runs, so the gate cannot pass where the contracts live and be absent where the
 *  handlers do. */
export const automationRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(AUTOMATION_COMMANDS).map((c) => c.contract))

/** The procs this family serves on `transport`, in table order. */
export const automationCommandsOn = (transport: TransportTag): AutomationProcName[] =>
  (Object.keys(AUTOMATION_COMMANDS) as AutomationProcName[]).filter((proc) =>
    isAutomationCommandExposedOn(proc, transport),
  )
