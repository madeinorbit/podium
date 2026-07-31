/**
 * THE APPROVAL QUERY — `list`, the operator's pending queue.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE HERE AND NOT A READ CONTRACT IN `@podium/commands`
 * ---------------------------------------------------------------------------
 *
 * The same line `modules/workflows/queries.ts` drew and POD-386 and POD-735 both
 * held: `CommandContract` requires a `visibility` class, and a visibility class
 * describes WHAT A COMMAND WRITES. A read writes nothing. Declaring one anyway —
 * `personal`, copied off the two decision contracts next door — would put a value
 * in the audit surface that `contracts.test.ts` grades against ADR 1's ownership
 * matrix, for a row this query does not write. That is a FALSE entry in the audit
 * surface, not a missing one.
 *
 * Read contracts are POD-311's remaining work and the read/tenant-visible ratchet
 * belongs to ADR 1 Amendment 1 D9.3 (POD-1071). A router cutover that invented the
 * read half of the vocabulary would be deciding a question two other issues own.
 *
 * What the query DOES get is the property that actually mattered, and the reason
 * this file exists rather than the procedure staying in `router.ts`: ONE
 * declaration of which reads exist and where they are served, default-closed, in
 * the module that owns the service — instead of a procedure body in a 1200-line
 * router that no audit could attribute to a family.
 *
 * AUTHORIZATION IS NOT HERE and must not move here. `run` is one call into the
 * service. This table decides WHICH READS EXIST AND WHERE THEY ARE SERVED, never
 * who may take them.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { ApprovalService } from './service'

/** `trpc` alone, matching the two decision contracts' `SERVED_ON`. The agent side
 *  reads its own request through the issue relay's arm, not through this. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface ApprovalQuery<In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (service: ApprovalService, input: z.infer<In>) => Out
}

/** Preserves the schema and return types through the object literal below —
 *  without it every entry widens to `ZodTypeAny`/`unknown` and the web client
 *  loses `AppRouter` inference on the read. */
const query = <In extends z.ZodTypeAny, Out>(
  input: In,
  run: (service: ApprovalService, input: z.infer<In>) => Out,
): ApprovalQuery<In, Out> => ({ input, exposure: SERVED_ON, run })

/**
 * `list` takes no input. `.passthrough()` rather than a strict empty object, kept
 * deliberately: the shipped procedure had no `.input(…)` at all, so it accepted
 * anything, and a strict object would start refusing extra keys that shipped
 * clients may already send — a wire change wearing a tidy-up's clothes.
 */
const noInput = z.object({}).passthrough().optional()

export const APPROVAL_QUERIES = {
  /** The operator decision surface's queue: every request still awaiting an
   *  answer, already projected to the wire shape by the service. */
  list: query(noInput, (service) => service.listPending()),
} as const

export type ApprovalQueryName = keyof typeof APPROVAL_QUERIES

export const isApprovalQuery = (proc: string): proc is ApprovalQueryName =>
  Object.hasOwn(APPROVAL_QUERIES, proc)

/** ADR 3 D3, default-closed, for the read half. An unknown proc is `false`, so a
 *  typo removes a surface loudly instead of opening one silently. */
export function isApprovalQueryExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isApprovalQuery(proc)) return false
  return APPROVAL_QUERIES[proc].exposure.includes(transport)
}
