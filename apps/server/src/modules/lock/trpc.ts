import type { TRPCMutationProcedure, TRPCQueryProcedure } from '@trpc/server'
import type { z } from 'zod'
import { type Context, issueCaller, mods, t } from '../../trpc'
import { type AnyLockCommandDef, guardLockCommand } from './registry'

/**
 * Derive the `lock:` tRPC sub-router from the lock command registry
 * [spec:SP-85d1] — the small parallel of modules/issues/trpc.ts
 * routerFromCommands (which is issues-specific: its guard needs the
 * IssueService for subtree resolution; locks are role-gated only). One
 * procedure per definition, resolver = the same dispatcher handler the daemon
 * relay runs, so the surfaces cannot drift.
 */

type ProcedureFor<D extends AnyLockCommandDef> = D['kind'] extends 'mutation'
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

type ProceduresFor<T extends Record<string, AnyLockCommandDef>> = {
  [K in keyof T]: ProcedureFor<T[K]>
}

function guardFor(def: AnyLockCommandDef) {
  return t.middleware(async ({ ctx, next }) => {
    guardLockCommand(issueCaller(ctx), def)
    return next()
  })
}

export function lockRouterFromCommands<T extends Record<string, AnyLockCommandDef>>(registry: {
  defs: T
}) {
  const record: Record<string, unknown> = {}
  for (const [name, def] of Object.entries<AnyLockCommandDef>(registry.defs)) {
    const proc = t.procedure.use(guardFor(def)).input(def.input)
    const resolve = (opts: { ctx: Context; input: unknown }) =>
      mods(opts.ctx).lockCommands.run(issueCaller(opts.ctx), name, def, opts.input)
    record[name] = def.kind === 'mutation' ? proc.mutation(resolve) : proc.query(resolve)
  }
  return t.router(record as ProceduresFor<T>)
}
