/**
 * THE SPEC ARM OF THE AGENT RELAY (POD-6418).
 *
 * `podium spec` reaches the server through the daemon relay as `specs.<proc>`.
 * Its writes are plain registrations (`plain-family.ts`), served by the relay
 * write adapter (`write-routes/relay.ts`) through the same front door as on tRPC
 * (exposure on the relay, the role floor, then the parse). Its reads stay the
 * service's own (`SpecsService.invoke`), which runs the repo-root gate for every
 * proc.
 *
 * An unknown proc is {@link NO_SUCH_SPEC_PROC}, which the relay answers as "no such
 * procedure"; a refusal is an error with a sentence naming it.
 */

import { isSpecCommand } from './registry'
import type { SpecsService } from './service'

export const NO_SUCH_SPEC_PROC: unique symbol = Symbol('no such spec proc')

export async function dispatchSpecRelay(
  specs: SpecsService,
  proc: string,
  input: unknown,
): Promise<unknown> {
  // A write is a plain registration, served by the relay write adapter
  // (`write-routes/relay.ts`) before this arm; it never reaches here.
  if (isSpecCommand(proc)) return NO_SUCH_SPEC_PROC
  return specs.has(proc) ? await specs.invoke(proc, input) : NO_SUCH_SPEC_PROC
}
