/**
 * THE SHARED SHAPE OF A QUERY TABLE (POD-314).
 *
 * Ten families in this cutover declare reads, and each was writing the same three
 * declarations to do it: a `Query<In, Out>` interface, a `query()` helper that
 * preserves the schema and return types through an object literal, and a
 * `SERVED_ON`. Factored here for the reason `derived-family.ts` factors the
 * builder — the tenth copy is where they start to disagree.
 *
 * WHY THE `query()` HELPER EXISTS AT ALL, since it looks like an identity
 * function: without it every entry in a table literal widens to
 * `ZodTypeAny`/`unknown`, and the web client loses `AppRouter` inference on every
 * read in the family. Same class of failure as POD-732's, same invisibility at
 * runtime. `modules/workflows/queries.ts` has the original.
 *
 * A QUERY TABLE IS NOT A CONTRACT TABLE and must not become one. A read carries
 * no `visibility` class because a visibility class describes what a command
 * WRITES — the line POD-386 and POD-735 both held. What a table entry decides is
 * WHICH READS EXIST AND WHERE THEY ARE SERVED (ADR 3 D3, default-closed);
 * authorization stays in the service the `run` calls into.
 */

import type { TransportTag } from '@podium/commands'
import type { z } from 'zod'

/** Both shipped arms for reads that agents reach too; most families are trpc-only
 *  and say so by naming just that. */
export const TRPC_ONLY: readonly TransportTag[] = ['trpc']

export interface Query<Svc, In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (service: Svc, input: z.infer<In>) => Out
}

/** Preserves the schema and return types through a table literal — see the
 *  header for why this is not an identity function. */
export const defineQuery =
  <Svc>() =>
  <In extends z.ZodTypeAny, Out>(
    input: In,
    run: (service: Svc, input: z.infer<In>) => Out,
    exposure: readonly TransportTag[] = TRPC_ONLY,
  ): Query<Svc, In, Out> => ({ input, exposure, run })
