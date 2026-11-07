import {
  ISSUE_CONTRACTS,
  type IssueContractName,
  isSyncedIssueCommand,
  writesThroughEntry,
} from '@podium/commands'
import { TRPCError, type TRPCMutationProcedure, type TRPCQueryProcedure } from '@trpc/server'
import type { z } from 'zod'
import { type Context, issueCaller, t } from '../../trpc'
import { familyState } from '../derived-family'
import { refusalAsTrpcError } from '../sync-write/route-adapter'
import { directRoute } from '../write-routes/direct'
import { syncRoute } from '../write-routes/sync'
import { commandAccess } from './command-ctx'
import { type AnyIssueCommandDef, guardIssueCommand } from './registry'
import { isIssueNotFound } from './service/not-found'
import { isIssueRefusal } from './service/refusal'
import { answerMailSendAsBefore, startAfterCreate, submitIssueWrite } from './sync-write'

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
    await guardIssueCommand(
      issueCaller(ctx),
      commandAccess(familyState(ctx).modules.issues),
      name,
      def,
      await getRawInput(),
    )
    return await next()
  })
}

/**
 * THE ONE PLACE a vanished issue becomes a 404 (POD-1926) and a definitive
 * precondition refusal becomes a 409 (POD-5429).
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
 * read `err.message`, which both domain error types leave exactly as the bare
 * `Error` left it. Unknown errors remain genuine faults / transient 500s.
 */
function rethrowAsTrpc(err: unknown): never {
  if (isIssueNotFound(err)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err })
  }
  if (isIssueRefusal(err)) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err })
  }
  throw err
}

/**
 * A listed issue command's route (`SYNCED_ISSUE_COMMANDS`): A THIN ADAPTER ONTO
 * the sync write entry point (POD-6350, POD-6413). LEGACY(remove-after: 2027-03):
 * older CLIs and the shipped mobile app call these routes; removing one breaks
 * that client's write. The guard middleware above still runs first, so a refused
 * caller keeps the message it always got; the entry point then checks again,
 * deduplicates and runs the handler in one unit of work. A handler's own error
 * comes back as the refusal's cause and is answered exactly as before. A create
 * that asked to start starts after its commit (`startAfterCreate`).
 */
async function throughEntry(ctx: Context, name: string, input: unknown): Promise<unknown> {
  const modules = familyState(ctx).modules
  const { reply, cause } = await submitIssueWrite(modules.syncWrite, {
    principal: ctx.principal,
    transport: 'trpc',
    name,
    input,
    confirmed: ctx.overrideScope === true,
  })
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) return rethrowAsTrpc(cause)
    throw refusalAsTrpcError(`issues.${name}`, reply.refusal)
  }
  if (name === 'mailSend') {
    return await answerMailSendAsBefore(
      async (id) => await modules.messages.handOnOf(id),
      reply.result,
    )
  }
  if (name !== 'create') return reply.result
  try {
    return await startAfterCreate(modules.issues, issueCaller(ctx), input, reply.result)
  } catch (err) {
    return rethrowAsTrpc(err)
  }
}

export function routerFromCommands<T extends Record<string, AnyIssueCommandDef>>(registry: {
  defs: T
}) {
  const record: Record<string, unknown> = {}
  for (const [name, def] of Object.entries<AnyIssueCommandDef>(registry.defs)) {
    const guard = guardFor(name, def)
    // Check-run-record can yield even for a synchronous handler. MutationLedger
    // reserves the mutation id before its durable lookup yields and keeps that
    // join point through receipt recording, so same-batch replays join the owner.
    // The resolver awaits dispatch here so its rejection is mapped to tRPC once.
    const resolve = async (opts: { ctx: Context; input: unknown }) => {
      if (writesThroughEntry(name, opts.input))
        return await throughEntry(opts.ctx, name, opts.input)
      try {
        return await familyState(opts.ctx).modules.issueCommands.run(
          issueCaller(opts.ctx),
          name,
          def,
          opts.input,
        )
      } catch (err) {
        return rethrowAsTrpc(err)
      }
    }
    if (def.kind !== 'mutation') {
      record[name] = t.procedure.use(guard).input(def.input).query(resolve)
      continue
    }
    const contract = ISSUE_CONTRACTS[name as IssueContractName]
    // A synced command's route is its sync registration's (a `panelApply` that
    // adds an artifact reaches it as an effect record); any other write is in
    // the direct-write census until POD-6603 moves it onto the entry point.
    record[name] = isSyncedIssueCommand(name)
      ? syncRoute({ command: contract, input: def.input, use: [guard], run: resolve })
      : directRoute(contract.name, { input: def.input, use: [guard], run: resolve })
  }
  return t.router(record as ProceduresFor<T>)
}
