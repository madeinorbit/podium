/**
 * THE DERIVED SUPERAGENT SURFACE (POD-383) — every superagent thread mutation,
 * produced from the contract table rather than written out.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS THERE BEFORE
 * ---------------------------------------------------------------------------
 *
 * Eight procedures in `router.ts`, each restating an input schema beside a call
 * onto `SuperagentService`. SEVEN of them were `.mutation(`, and two of those
 * seven — `send` and `sendTurn` — were the same procedure written twice:
 * identical schemas, identical bodies, one alias. That is a second declaration
 * of a surface that already declares itself, and the duplicate is the fork this
 * issue was opened to end.
 *
 * `scripts/audit-superagent-commands.ts` fails the build if a `.mutation(`
 * reappears inside the `superagent:` router literal, or if the alias grows back
 * — the same gate POD-382 put on the session family and POD-732 on workflows,
 * for the same reason.
 *
 * ---------------------------------------------------------------------------
 * EXPOSURE DRIVES THE WIRE (ADR 3 D3, default-closed)
 * ---------------------------------------------------------------------------
 *
 * A command appears here if and only if its contract declares `trpc`. Nobody
 * maintains a second list saying so, and the check is at MODULE LOAD: a contract
 * that loses `trpc` while still being built here throws before the server serves
 * a request, rather than serving a procedure that refuses everything — the
 * "green gate that stopped looking" failure.
 *
 * ---------------------------------------------------------------------------
 * WHY OUTPUT TYPES SURVIVE THE DERIVATION
 * ---------------------------------------------------------------------------
 *
 * `AppRouter` inference is what makes `trpc.superagent.sendTurn.mutate(…)`
 * checked at all in `apps/web` — and the web reads the ack's `podiumSessionId`
 * off it. A naive generic derivation types every result `unknown` and the damage
 * lands silently on every call site, not here. So the mutation output is read
 * off the JOINED HANDLER's return type (the registry pairs contract with
 * handler, so the handler is in scope) rather than written down a second time.
 *
 * ---------------------------------------------------------------------------
 * THE THREAD LOCK DID NOT MOVE
 * ---------------------------------------------------------------------------
 *
 * Every body below is `handler(ctx.superagent, input)` — the same service
 * method the hand-written procedure called, with no check added, removed or
 * reordered in front of it. The one-writer rule (`sendTurn` / `restart` /
 * `openInTerminal` refuse under the terminal lock and while a turn is in
 * flight; `clear` releases it) lives in `service.ts` and is exercised by
 * `superagent.test.ts` against the service, which is where a liveness rule must
 * be tested from.
 */

import type { TRPCMutationProcedure } from '@trpc/server'
import type { z } from 'zod'
import { t } from '../../trpc'
import { SUPERAGENT_COMMANDS, type SuperagentProcName } from './registry'

type MutationProcedure<N extends SuperagentProcName> = TRPCMutationProcedure<{
  meta: unknown
  input: z.input<(typeof SUPERAGENT_COMMANDS)[N]['contract']['input']>
  output: ReturnType<(typeof SUPERAGENT_COMMANDS)[N]['handler']>
}>

/**
 * One mutation, built out of its contract: the contract's own schema instance
 * for validation and for the client's input type, and a body that is the joined
 * handler applied to the request's `SuperagentService`.
 */
function superagentMutation<N extends SuperagentProcName>(name: N): MutationProcedure<N> {
  const { contract, handler } = SUPERAGENT_COMMANDS[name]
  if (!contract.exposure.includes('trpc')) {
    throw new Error(`superagent.${name} does not declare the trpc transport`)
  }
  return t.procedure
    .input(contract.input)
    .mutation(({ ctx, input }) =>
      (handler as (s: typeof ctx.superagent, i: unknown) => unknown)(ctx.superagent, input),
    ) as MutationProcedure<N>
}

type SuperagentProcedures = { [N in SuperagentProcName]: MutationProcedure<N> }

/**
 * Every superagent thread mutation, keyed by its bare proc name — spread into
 * the `superagent:` router in `router.ts`, which then contains only its two
 * queries.
 *
 * Built by iterating the TABLE, not a list written here: an eighth contract is
 * served because it was declared, and the only way to remove a procedure is to
 * remove its declaration. That is also what makes the deletion of `send`
 * structural rather than editorial — there is no second key to forget.
 */
export function superagentFamilyProcedures(): SuperagentProcedures {
  const record: Record<string, unknown> = {}
  for (const name of Object.keys(SUPERAGENT_COMMANDS) as SuperagentProcName[]) {
    record[name] = superagentMutation(name)
  }
  return record as SuperagentProcedures
}
