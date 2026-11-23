/**
 * THE OLD PER-COMMAND ROUTES AS THIN ADAPTERS (POD-6350, plan Task 10).
 *
 * The 27 commands the apps queue moved onto `sync.submit`. Their old tRPC routes
 * (`layout.set`, `issues.update`, `sessions.sendText`, …) stay until POD-6359
 * removes them, because older apps still call them; each now builds the envelope
 * the outbox would have built and hands it to the one entry point. The route
 * keeps only its WIRE: its input schema, and how it answers a refusal.
 *
 * WHICH mutationId. The one the input carries, when it carries one: that is the
 * id an older app's queue minted for the write, so its retries dedupe against
 * each other and against a newer app's `sync.submit` of the same entry. A call
 * without one (the CLI, a test) gets a fresh id: it is deduplicated against
 * nothing, which is what a call with no id always meant.
 */

import { randomUUID } from 'node:crypto'
import { asMutationId } from '@podium/model'
import type { SyncSubmitRefusal } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import type { Context } from '../../trpc'
import { familyState } from '../derived-family'
import type { DetailedSubmit } from './entry'

/** One old route's call, as the envelope the entry point takes. */
export interface RouteCall {
  readonly command: string
  readonly input: unknown
  /** The contract version. Every queued command is at 1 today. */
  readonly version?: number
}

/** The id an envelope built from `input` carries (see the header). */
export function mutationIdOf(input: unknown) {
  const carried =
    input !== null && typeof input === 'object'
      ? (input as { mutationId?: unknown }).mutationId
      : undefined
  return typeof carried === 'string' && carried.length > 0
    ? asMutationId(carried)
    : asMutationId(`mut_route_${randomUUID()}`)
}

/**
 * Submit one old-route call through the entry point, as this tRPC caller.
 *
 * `confirmed` is the context's `overrideScope`: the one out-of-scope
 * confirmation a tRPC caller can carry today (an in-process MCP caller built
 * with `--outside-scope`).
 */
export async function submitFromRoute(ctx: Context, call: RouteCall): Promise<DetailedSubmit> {
  return await familyState(ctx).modules.syncWrite.submitDetailed(
    {
      mutationId: mutationIdOf(call.input),
      command: call.command,
      version: call.version ?? 1,
      input: call.input,
      ...(ctx.overrideScope === true ? { confirmed: true as const } : {}),
    },
    ctx.principal,
    'trpc',
  )
}

/**
 * A refusal with no family error behind it (the coarse or the target check),
 * as the tRPC error the client outbox classifies the same way: every one of
 * these is definitive, and none is a 500 it would retry. A target check that
 * refused in the family's own words (`refuseTarget`) answers with them.
 */
export function refusalAsTrpcError(command: string, refusal: SyncSubmitRefusal): TRPCError {
  if (refusal.message !== undefined) {
    return new TRPCError({ code: TRPC_CODES[refusal.kind], message: refusal.message })
  }
  switch (refusal.kind) {
    case 'unauthorized':
      return new TRPCError({ code: 'FORBIDDEN', message: `${command} was refused` })
    case 'target-not-found':
      return new TRPCError({ code: 'NOT_FOUND', message: `${command}: no such target` })
    case 'conflict':
      return new TRPCError({ code: 'CONFLICT', message: `${command}: the target has changed` })
    case 'invalid':
      return new TRPCError({
        code: 'BAD_REQUEST',
        message: `${command}: invalid input${refusal.details?.length ? ` (${refusal.details.join(', ')})` : ''}`,
      })
    case 'confirmation-required':
      return new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `${command} is outside your scope; re-run with --outside-scope to confirm`,
      })
  }
}

const TRPC_CODES = {
  unauthorized: 'FORBIDDEN',
  'target-not-found': 'NOT_FOUND',
  conflict: 'CONFLICT',
  invalid: 'BAD_REQUEST',
  'confirmation-required': 'PRECONDITION_FAILED',
} as const satisfies Record<SyncSubmitRefusal['kind'], TRPCError['code']>

/**
 * The common adapter: the result on `applied`, and on a refusal the family's
 * own error when it threw one (so the route answers with the message and code
 * it always did), else {@link refusalAsTrpcError}.
 */
export async function routeThroughEntry(ctx: Context, call: RouteCall): Promise<unknown> {
  const { reply, cause } = await submitFromRoute(ctx, call)
  if (reply.outcome === 'applied') return reply.result
  if (cause !== undefined) throw cause
  throw refusalAsTrpcError(call.command, reply.refusal)
}
