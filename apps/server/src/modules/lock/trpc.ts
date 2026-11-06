import { familyState } from '../derived-family'
import { TRPCError, type TRPCMutationProcedure, type TRPCQueryProcedure } from '@trpc/server'
import { ZodError, type z } from 'zod'
import { type Context, issueCaller, t } from '../../trpc'
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
    return await next()
  })
}

/** A write's input is parsed by the plain entry, after the coarse check. */
const unparsed = (raw: unknown): unknown => raw

/**
 * The WRITES take the plain command path (POD-6419): the front door, then the
 * handler inside the plain scope, the same door as the relay's
 * (`LockCommandDispatcher.runPlain`). The procedure does not parse, so a refused
 * caller learns nothing from validation errors. The read keeps the guard.
 */
export function lockRouterFromCommands<T extends Record<string, AnyLockCommandDef>>(registry: {
  defs: T
}) {
  const record: Record<string, unknown> = {}
  for (const [name, def] of Object.entries<AnyLockCommandDef>(registry.defs)) {
    if (def.kind === 'mutation') {
      record[name] = t.procedure.input(unparsed).mutation(async ({ ctx, input }) => {
        try {
          return await familyState(ctx).modules.lockCommands.runPlain(
            issueCaller(ctx),
            ctx.principal,
            'trpc',
            name,
            input,
          )
        } catch (error) {
          // Bad input answers as tRPC's own validation always did.
          if (error instanceof ZodError) {
            throw new TRPCError({ code: 'BAD_REQUEST', cause: error })
          }
          throw error
        }
      })
      continue
    }
    const proc = t.procedure.use(guardFor(def)).input(def.input)
    record[name] = proc.query((opts: { ctx: Context; input: unknown }) =>
      familyState(opts.ctx).modules.lockCommands.run(issueCaller(opts.ctx), name, def, opts.input),
    )
  }
  return t.router(record as ProceduresFor<T>)
}
