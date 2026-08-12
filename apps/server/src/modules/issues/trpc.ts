import { familyState } from '../derived-family'
import { TRPCError, type TRPCMutationProcedure, type TRPCQueryProcedure } from '@trpc/server'
import type { z } from 'zod'
import { type Context, issueCaller, mods, t } from '../../trpc'
import { type AnyIssueCommandDef, guardIssueCommand } from './registry'
import { isIssueNotFound } from './service/not-found'

/**
 * Derive the `issues:` tRPC sub-router from the command registry (#248
 * [spec:SP-3fe2]): one procedure per definition — keyed by def name, input =
 * def.input, guarded by the capability middleware that reads `def.action` /
 * `def.target` from the DEFINITION (the old issueCapabilityGuard parsed the
 * middleware path string to find the proc, so renaming a proc silently changed
 * its permissions). The resolver runs the same handler the relay/MCP dispatch
 * runs (via familyState(ctx).modules.issueCommands), so the four surfaces cannot drift.
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
    guardIssueCommand(
      issueCaller(ctx),
      familyState(ctx).modules.issues,
      name,
      def,
      await getRawInput(),
    )
    return next()
  })
}

/**
 * THE ONE PLACE a vanished issue becomes a 404 (POD-1926).
 *
 * The service throws a transport-free {@link IssueNotFound}; tRPC has no mapping
 * for an unrecognised `Error` and would answer INTERNAL_SERVER_ERROR / 500. That
 * is not merely the wrong number: the client outbox classifies an unrecognised
 * failure as TRANSIENT and retries it, under ADR 3 D10, until the 14-day age
 * limit — so a read receipt for a purged draft looped once a minute for a
 * fortnight. `NOT_FOUND` classifies as `target-not-found`, which is definitive.
 *
 * It sits here, wrapping every derived procedure, rather than in each handler:
 * `guardIssueCommand` only extracts `def.target` for a CONSTRAINED capability, so
 * an operator reaches the service for every command, and the per-user commands
 * (`markRead`, `markUnread`, `setTucked`) declare no target for any caller. A
 * per-handler fix would have to be remembered ~60 times.
 *
 * The relay gate and the MCP surface deliberately do NOT go through here — they
 * read `err.message`, which `IssueNotFound` leaves exactly as the bare `Error`
 * left it.
 */
function rethrowAsTrpc(err: unknown): never {
  if (isIssueNotFound(err)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err })
  }
  throw err
}

export function routerFromCommands<T extends Record<string, AnyIssueCommandDef>>(registry: {
  defs: T
}) {
  const record: Record<string, unknown> = {}
  for (const [name, def] of Object.entries<AnyIssueCommandDef>(registry.defs)) {
    const proc = t.procedure.use(guardFor(name, def)).input(def.input)
    // Not an `async` wrapper: a synchronous handler must stay synchronous, or the
    // mutation ledger's check-run-record pass stops being one uninterrupted turn
    // and a replay in the same tRPC batch could interleave with its original.
    const resolve = (opts: { ctx: Context; input: unknown }) => {
      try {
        const out = familyState(opts.ctx).modules.issueCommands.run(
          issueCaller(opts.ctx),
          name,
          def,
          opts.input,
        )
        return out instanceof Promise ? out.catch(rethrowAsTrpc) : out
      } catch (err) {
        return rethrowAsTrpc(err)
      }
    }
    record[name] = def.kind === 'mutation' ? proc.mutation(resolve) : proc.query(resolve)
  }
  return t.router(record as ProceduresFor<T>)
}
