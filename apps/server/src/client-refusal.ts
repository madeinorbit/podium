/**
 * THE BRAND OF A REFUSAL WRITTEN FOR THE CALLER (POD-7617).
 *
 * An unexpected failure answers every client with a generic sentence and a log
 * reference, because its own message is the server's text (a store wrapper's
 * SQL). A refusal's message is written for the caller and must reach them. A
 * domain refusal class carries this brand with the tRPC code it answers with;
 * `client-error-diagnostics.ts` reads it for every transport. This module has
 * no runtime imports, so a service's error class can carry the brand without
 * taking on transport code.
 */

import type { TRPCError } from '@trpc/server'

/** A tRPC code a refusal answers with: anything but a server fault. */
export type RefusalCode = Exclude<TRPCError['code'], 'INTERNAL_SERVER_ERROR'>

/**
 * The brand of an error written for the caller. A domain refusal class (an
 * `IssueRefusal`, a `MailRefusal`) carries it with the tRPC code it answers
 * with, so every transport can tell its sentence from a fault's without
 * importing the class: tRPC answers it with that code
 * (`brandedRefusalInPlaceOfFault`), and the agent relay and MCP reply its
 * message (`failureForClient`).
 *
 * A class brands itself with a getter keyed by this symbol, returning a fixed
 * code or mapping its `kind` through {@link refusalKindCode}. A getter lives on
 * the prototype, so an error's own properties (what equality and
 * serialization read) are unchanged.
 */
export const CLIENT_REFUSAL: unique symbol = Symbol.for('podium.client-refusal')

/** The code a branded refusal answers with; `undefined` for anything else. */
export function clientRefusalCode(error: unknown): RefusalCode | undefined {
  if (typeof error !== 'object' || error === null || !(CLIENT_REFUSAL in error)) return undefined
  const code = (error as { [CLIENT_REFUSAL]: unknown })[CLIENT_REFUSAL]
  return typeof code === 'string' ? (code as RefusalCode) : undefined
}

/** The tRPC code each sync refusal kind answers with, as `SYNC_REFUSAL_CODES`
 *  in `@podium/protocol`; `not-found` is the workflow and automation spelling. */
export function refusalKindCode(
  kind:
    | 'unauthorized'
    | 'target-not-found'
    | 'not-found'
    | 'conflict'
    | 'invalid'
    | 'confirmation-required',
): RefusalCode {
  switch (kind) {
    case 'unauthorized':
      return 'FORBIDDEN'
    case 'target-not-found':
    case 'not-found':
      return 'NOT_FOUND'
    case 'conflict':
      return 'CONFLICT'
    case 'invalid':
      return 'BAD_REQUEST'
    case 'confirmation-required':
      return 'PRECONDITION_FAILED'
  }
}
