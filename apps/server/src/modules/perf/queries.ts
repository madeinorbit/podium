/**
 * THE PERF QUERY — `snapshot`.
 *
 * A table rather than a read contract: a `visibility` class describes what a
 * command WRITES and a read writes nothing. See `modules/workflows/queries.ts`.
 */

import type { TransportTag } from '@podium/commands'
import { z } from 'zod'
import type { PerfState } from './commands'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface PerfQuery<In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (state: PerfState, input: z.infer<In>) => Out
}

const query = <In extends z.ZodTypeAny, Out>(
  input: In,
  run: (state: PerfState, input: z.infer<In>) => Out,
): PerfQuery<In, Out> => ({ input, exposure: SERVED_ON, run })

/** `.passthrough()` rather than a strict empty object: the shipped procedure had
 *  no `.input(…)` and accepted anything, and newly refusing extra keys would be a
 *  wire change wearing a tidy-up's clothes. */
const noInput = z.object({}).passthrough().optional()

export const PERF_QUERIES = {
  /** Rolling server-side timings — every rpc via the trpc.ts middleware, plus the
   *  named internal phases and the client switch-trace ring [POD-701]. */
  snapshot: query(noInput, (state) => state.perf.snapshot()),
} as const

export type PerfQueryName = keyof typeof PERF_QUERIES

export const isPerfQuery = (proc: string): proc is PerfQueryName =>
  Object.hasOwn(PERF_QUERIES, proc)

export function isPerfQueryExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isPerfQuery(proc)) return false
  return PERF_QUERIES[proc].exposure.includes(transport)
}
