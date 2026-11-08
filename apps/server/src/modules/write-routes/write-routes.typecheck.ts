/**
 * A MODULE CANNOT BUILD A WRITE ROUTE (ADR 12 D9, POD-6593), held by the server
 * typecheck: the builder modules get (`t.procedure`) has no `.mutation`, before
 * or after an input, an output, a meta or a middleware. Every write route is
 * generated from a registration by `write-routes/`. Never called; the file is
 * here for the compiler.
 */

import { z } from 'zod'
import { t } from '../../trpc'

export function aModuleCannotBuildAWrite(): unknown[] {
  const middleware = t.middleware(async ({ next }) => await next())
  return [
    // @ts-expect-error the module builder has no `.mutation`
    t.procedure.mutation(async () => 1),
    // @ts-expect-error not after an input
    t.procedure.input(z.object({ id: z.string() })).mutation(async () => 1),
    // @ts-expect-error not after an output
    t.procedure.output(z.number()).mutation(async () => 1),
    // @ts-expect-error not after a meta
    t.procedure.meta({}).mutation(async () => 1),
    // @ts-expect-error not after a middleware
    t.procedure.use(middleware).mutation(async () => 1),
    // A query builds, with its input typed.
    t.procedure.input(z.object({ id: z.string() })).query(({ input }) => input.id.length),
  ]
}
