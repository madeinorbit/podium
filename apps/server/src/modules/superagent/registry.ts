/**
 * THE JOIN — the seven superagent contracts (L1, `@podium/commands`) paired
 * with the handlers that implement them (L3, `SuperagentService`), per ADR 3 D1
 * and POD-311's three-way split. POD-383 (3.3a).
 *
 * A transport does not reach a service method; it reaches a CONTRACT by name,
 * the contract's schema validates the input, and only then does the joined
 * handler run. An eighth thread command added to this table is validated,
 * classified and exposure-checked because it declared itself — not because
 * whoever added it remembered.
 *
 * WHAT THIS TABLE DELIBERATELY DOES NOT DO: it does not re-implement, re-order
 * or relax anything the service does. Every handler is a one-line call onto the
 * SAME method the hand-written procedure called, so the thread-lock semantics —
 * `sendTurn`/`restart`/`openInTerminal` refusing while a turn is in flight or a
 * terminal attachment holds the one-writer lock, and `clear` RELEASING that lock
 * rather than refusing it — stay exactly where they are enforced today. A
 * migration that moved a liveness check into a transport would be a migration
 * that changed behaviour while claiming not to.
 *
 * The two READS this surface serves (`listThreads`, `history`) are not here and
 * are not contracts: a `visibility` class describes what a command WRITES, and a
 * read writes nothing. They stay hand-written queries on the router, and the
 * audit checks procedure TYPE so a read cannot hide a write.
 */

import {
  type AnyCommandContract,
  type ContractInput,
  registryClassificationErrors,
  SUPERAGENT_CONTRACTS,
  type SuperagentContractName,
  type TransportTag,
} from '@podium/commands'
import type { SuperagentService } from './service'

/** The PARSED input of a contract — the handler's argument type, derived from
 *  the contract's own schema so a handler cannot disagree with what validates. */
type In<N extends SuperagentContractName> = ContractInput<(typeof SUPERAGENT_CONTRACTS)[N]>

/** One contract joined to the handler that implements it. */
export interface SuperagentCommand {
  readonly contract: AnyCommandContract
  readonly handler: (service: SuperagentService, input: never) => unknown
}

/**
 * The joined table, keyed by the BARE PROC NAME every transport already
 * dispatches on. The wire names are kept — renaming one is a
 * client-compatibility change and this is a migration.
 *
 * SIX KEYS WHERE THERE WERE SEVEN PROCEDURES. `superagent.send` was
 * `superagent.sendTurn`'s byte-identical alias, forwarding to the same service
 * method; the caller census (eleven `sendTurn` sites across web, mobile, the
 * client engine and the browser e2e; ZERO for `send`) decided which name
 * survives, per POD-1075's precedent that persistence beats aesthetics. It is
 * DELETED rather than re-homed: a deprecation window would preserve a name
 * nothing has ever sent, which is how a fork survives a dedupe.
 */
export const SUPERAGENT_COMMANDS = {
  sendTurn: {
    contract: SUPERAGENT_CONTRACTS.sendTurn,
    handler: (s: SuperagentService, input: In<'sendTurn'>) => s.sendTurn(input),
  },
  interruptTurn: {
    contract: SUPERAGENT_CONTRACTS.interruptTurn,
    handler: (s: SuperagentService, input: In<'interruptTurn'>) => s.interruptTurn(input),
  },
  openInTerminal: {
    contract: SUPERAGENT_CONTRACTS.openInTerminal,
    handler: (s: SuperagentService, input: In<'openInTerminal'>) => s.openInTerminal(input),
  },
  clear: {
    contract: SUPERAGENT_CONTRACTS.clear,
    handler: (s: SuperagentService, input: In<'clear'>) => s.clear(input.threadId),
  },
  restart: {
    contract: SUPERAGENT_CONTRACTS.restart,
    handler: (s: SuperagentService, input: In<'restart'>) => s.restartThread(input),
  },
  startBtw: {
    contract: SUPERAGENT_CONTRACTS.startBtw,
    handler: (s: SuperagentService, input: In<'startBtw'>) => s.startBtwTurn(input),
  },
  concierge: {
    contract: SUPERAGENT_CONTRACTS.concierge,
    handler: (s: SuperagentService, input: In<'concierge'>) => s.conciergeTurn(input),
  },
} as const satisfies Record<SuperagentContractName, SuperagentCommand>

export type SuperagentProcName = keyof typeof SUPERAGENT_COMMANDS

export const isSuperagentCommand = (proc: string): proc is SuperagentProcName =>
  proc in SUPERAGENT_COMMANDS

/**
 * ADR 3 D3, enforced rather than documented. Default-closed: an unknown proc is
 * `false`, not "probably fine", so a typo at a call site removes a surface
 * loudly instead of opening one silently.
 */
export function isSuperagentProcExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isSuperagentCommand(proc)) return false
  return SUPERAGENT_COMMANDS[proc].contract.exposure.includes(transport)
}

/** The classification lint over the joined table. */
export const superagentRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(Object.values(SUPERAGENT_COMMANDS).map((c) => c.contract))
