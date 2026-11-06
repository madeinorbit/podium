/**
 * THE SPEC ARM OF THE AGENT RELAY (POD-6418).
 *
 * `podium spec` reaches the server through the daemon relay as `specs.<proc>`.
 * Its writes take the plain command path, the same door as on tRPC (`trpc.ts`):
 * the front door (exposure on the relay, the role floor, then the parse) and the
 * plain handler. Its reads stay the service's own (`SpecsService.invoke`), which
 * runs the repo-root gate for every proc.
 *
 * An unknown proc is {@link NO_SUCH_SPEC_PROC}, which the relay answers as "no such
 * procedure"; a refusal is an error with a sentence naming it.
 */

import type { CommandPrincipal } from '../../command-principal'
import { runPlainCommand } from '../plain-command/entry'
import { isSpecCommand, SPEC_COMMANDS_TRPC } from './registry'
import type { SpecsService } from './service'

export const NO_SUCH_SPEC_PROC: unique symbol = Symbol('no such spec proc')

export async function dispatchSpecRelay(
  specs: SpecsService,
  principal: () => Promise<CommandPrincipal>,
  proc: string,
  input: unknown,
): Promise<unknown> {
  if (isSpecCommand(proc)) {
    const { contract } = SPEC_COMMANDS_TRPC[proc]
    // The table is heterogeneous; each handler is pinned to its own contract's
    // input where it is declared, and the plain entry parses with that contract.
    const handler = SPEC_COMMANDS_TRPC[proc].handler as (
      svc: SpecsService,
      input: unknown,
    ) => unknown
    const reply = await runPlainCommand({
      contract,
      principal: await principal(),
      transport: 'relay',
      input,
      run: async (parsed) => await handler(specs, parsed),
    })
    if (reply.outcome === 'applied') return reply.result
    if (reply.refusal.kind === 'invalid') throw reply.refusal.error
    throw new Error(`${contract.name} is not permitted for this caller`)
  }
  return specs.has(proc) ? await specs.invoke(proc, input) : NO_SUCH_SPEC_PROC
}
