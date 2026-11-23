/**
 * A CREDENTIAL REFUSAL IS A REPLY, NOT A SERVER FAULT (POD-7066).
 *
 * A launch refused for its credential throws the refusal deep inside the
 * start (`CredentialRefusal`, or `CredentialRefError` for a named reference).
 * The refusals come from a closed list (`ACCESS_REFUSALS`), each with the
 * sentence a person reads, so a caller can act on them: the tRPC boundary
 * answers them as `PRECONDITION_FAILED` carrying the sentence and the code
 * (`credential:<refusal>`), never as a 500, and the server logs them without
 * a stack.
 */

import { type AccessRefusal, isAccessRefusal } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { CredentialRefusal } from '../sessions/launch-config'
import { CredentialRefError } from './credential-ref'

/** The tRPC code every credential refusal answers with. */
export const CREDENTIAL_REFUSAL_TRPC_CODE = 'PRECONDITION_FAILED' satisfies TRPCError['code']

export interface CarriedRefusal {
  readonly refusal: AccessRefusal
  /** The sentence a person reads. */
  readonly message: string
}

/**
 * The closed-list refusal an error is, or carries in its cause chain. A
 * `CredentialRefError` with no refusal (a label that names none or several)
 * is not one: its family answers it in its own words.
 */
export function credentialRefusalIn(error: unknown): CarriedRefusal | undefined {
  for (let at = error, depth = 0; at instanceof Error && depth < 4; depth++) {
    if (at instanceof CredentialRefusal || at instanceof CredentialRefError) {
      return isAccessRefusal(at.refusal) ? { refusal: at.refusal, message: at.message } : undefined
    }
    at = at.cause
  }
  return undefined
}

/** A refusal as the tRPC error a caller gets: its sentence, its code in the cause. */
export function credentialRefusedError(refusal: AccessRefusal, message: string): TRPCError {
  return new TRPCError({
    code: CREDENTIAL_REFUSAL_TRPC_CODE,
    message,
    cause: new CredentialRefusal(refusal, message),
  })
}

/**
 * The tRPC error a failed call should answer with when it is a credential
 * refusal tRPC took for a fault (a plain throw becomes `INTERNAL_SERVER_ERROR`
 * with the refusal as its cause); `undefined` leaves the error as it is.
 */
export function refusalInPlaceOfFault(error: TRPCError): TRPCError | undefined {
  if (error.code !== 'INTERNAL_SERVER_ERROR') return undefined
  const carried = credentialRefusalIn(error)
  return carried ? credentialRefusedError(carried.refusal, carried.message) : undefined
}
