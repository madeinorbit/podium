import type { TRPCMutationProcedure, TRPCQueryProcedure } from '@trpc/server'
import type { z } from 'zod'
import { type Context, issueCaller, mods, t } from '../../trpc'
import { type AnyIssueCommandDef, guardIssueCommand } from './registry'

/**
 * Derive the `issues:` tRPC sub-router from the command registry (#248
 * [spec:SP-3fe2]): one procedure per definition — keyed by def name, input =
 * def.input, guarded by the capability middleware that reads `def.action` /
 * `def.target` from the DEFINITION (the old issueCapabilityGuard parsed the
 * middleware path string to find the proc, so renaming a proc silently changed
 * its permissions). The resolver runs the same handler the relay/MCP dispatch
 * runs (via mods(ctx).issueCommands), so the four surfaces cannot drift.
 */

/** The precise procedure type one definition derives to — what keeps AppRouter
 *  (and thus the web client + createCaller tests) typed exactly as the
 *  hand-written procedures were: caller input is the schema's z.input, output
 *  is the handler's awaited return. */
type ProcedureFor<D extends AnyIssueCommandDef> = D['kind'] extends 'mutation'
  ? TRPCMutationProcedure<{
      meta: unknown
      input: z.input<D['input']>
      output: Awaited<ReturnType<D['handler']>>
    }>
  : TRPCQueryProcedure<{
      meta: unknown
      input: z.input<D['input']>
      output: Awaited<ReturnType<D['handler']>>
    }>

type ProceduresFor<T extends Record<string, AnyIssueCommandDef>> = {
  [K in keyof T]: ProcedureFor<T[K]>
}

/** The capability guard as tRPC middleware, one per definition. Runs on the RAW
 *  input BEFORE the input parser (attached ahead of `.input()`), exactly as the
 *  old path-parsing issueCapabilityGuard did. */
function guardFor(name: string, def: AnyIssueCommandDef) {
  return t.middleware(async ({ ctx, next, getRawInput }) => {
    guardIssueCommand(issueCaller(ctx), mods(ctx).issues, name, def, await getRawInput())
    return next()
  })
}

export function routerFromCommands<T extends Record<string, AnyIssueCommandDef>>(registry: {
  defs: T
}) {
  const record: Record<string, unknown> = {}
  for (const [name, def] of Object.entries<AnyIssueCommandDef>(registry.defs)) {
    const proc = t.procedure.use(guardFor(name, def)).input(def.input)
    const resolve = (opts: { ctx: Context; input: unknown }) =>
      mods(opts.ctx).issueCommands.run(issueCaller(opts.ctx), name, def, opts.input)
    record[name] = def.kind === 'mutation' ? proc.mutation(resolve) : proc.query(resolve)
  }
  return t.router(record as ProceduresFor<T>)
}
