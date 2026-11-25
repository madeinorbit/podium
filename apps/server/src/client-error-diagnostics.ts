import { describeError, type Logger } from '@podium/logger'
import { TRPCError } from '@trpc/server'
import { clientRefusalCode } from './client-refusal'

/**
 * Whether an error a client receives may carry the server's own diagnostics: the
 * stack (absolute install paths, internal function names) and the cause chain
 * (driver and store text). A server log line keeps both either way; this only
 * decides what leaves the process (POD-7615).
 *
 * Production is the packaged binary: `build-bun` bakes `PODIUM_APP_VERSION`,
 * dev-channel builds included, because a packaged dev install is still an
 * installed server other people reach. An explicit `NODE_ENV=production` also
 * counts. A server run from source (the dev server, tests) keeps the
 * diagnostics, which is what they are for.
 */
export function clientErrorDiagnostics(facts: {
  readonly packagedVersion: string | undefined
  readonly nodeEnv: string | undefined
}): boolean {
  if (facts.nodeEnv === 'production') return false
  return facts.packagedVersion === undefined
}

/**
 * This process's answer, fixed at load. The version read MUST stay the literal
 * `process.env.PODIUM_APP_VERSION`: `build-bun --define` rewrites only that exact
 * expression, so any other access would leave a packaged build reading undefined
 * and sending stacks again.
 */
export const CLIENT_ERROR_DIAGNOSTICS = clientErrorDiagnostics({
  packagedVersion: process.env.PODIUM_APP_VERSION,
  nodeEnv: process.env.NODE_ENV,
})

// ---------------------------------------------------------------------------
// Refusals and faults (POD-7617)
// ---------------------------------------------------------------------------

/**
 * Whether a tRPC error is a fault nobody wrote for the client: an
 * `INTERNAL_SERVER_ERROR` with a cause. tRPC builds exactly that around any
 * plain throw, and its message is then the thrown error's own (Drizzle's
 * `Failed query: insert into …` with the statement). An internal error a
 * procedure wrote itself, with a message and no cause, is a sentence for the
 * caller and stays.
 */
export function isUnexpectedFailure(error: {
  readonly code: string
  readonly cause?: unknown
}): boolean {
  return error.code === 'INTERNAL_SERVER_ERROR' && error.cause !== undefined
}

/**
 * The typed answer for a branded refusal tRPC took for a fault (a plain throw of
 * one becomes `INTERNAL_SERVER_ERROR` with it as the cause); `undefined` leaves
 * the error as it is.
 */
export function brandedRefusalInPlaceOfFault(error: TRPCError): TRPCError | undefined {
  if (!isUnexpectedFailure(error)) return undefined
  const code = clientRefusalCode(error.cause)
  if (code === undefined || !(error.cause instanceof Error)) return undefined
  return new TRPCError({ code, message: error.cause.message, cause: error.cause })
}

/** The first words of every unexpected failure's answer. */
export const UNEXPECTED_FAILURE = 'The server could not complete this request'

/** An unexpected failure's whole answer: the generic sentence and the reference
 *  the server logged the error under. */
export function unexpectedFailureMessage(reference: string): string {
  return `${UNEXPECTED_FAILURE}; the server log has the details (reference: ${reference})`
}

const references = new WeakMap<object, string>()

/**
 * The reference an unexpected failure is logged and answered under. tRPC hands
 * the same error object to `onError` (the log line) and to the formatter (the
 * reply), so both read one reference whichever runs first.
 */
export function failureReference(error: object): string {
  let reference = references.get(error)
  if (reference === undefined) {
    reference = crypto.randomUUID()
    references.set(error, reference)
  }
  return reference
}

/**
 * A refusal as the typed error its transports answer, or `undefined` for a
 * fault: a `TRPCError` that is not a fault as it is, an internal error a
 * procedure wrote without a cause included; a branded domain refusal (thrown as
 * it is, or as the cause tRPC wrapped it in) as a `TRPCError` with its code and
 * words. A wrapper that maps errors passes this on and rethrows anything else
 * unchanged, so a fault is never re-coded as a 4xx with its own text.
 */
export function typedRefusal(error: unknown): TRPCError | undefined {
  if (error instanceof TRPCError) {
    const typed = brandedRefusalInPlaceOfFault(error) ?? error
    return isUnexpectedFailure(typed) ? undefined : typed
  }
  const code = clientRefusalCode(error)
  if (code === undefined || !(error instanceof Error)) return undefined
  return new TRPCError({ code, message: error.message, cause: error })
}

/** A refusal's own words, or `undefined` for a fault ({@link typedRefusal}). */
export const refusalText = (error: unknown): string | undefined => typedRefusal(error)?.message

/** Whether an error is a refusal written for the caller ({@link typedRefusal}). */
export const isClientRefusal = (error: unknown): boolean => typedRefusal(error) !== undefined

/**
 * Whether an error is a schema's own `ZodError`. The agent relay passes a
 * write's invalid input on as one, and its arms parse their input themselves,
 * so for an agent its list of what the input got wrong is the answer. tRPC
 * validates a procedure's input before the procedure runs; a `ZodError` from
 * inside one is a parse of the server's own data and stays a fault there.
 */
const isSchemaError = (error: unknown): error is Error =>
  error instanceof Error && error.name === 'ZodError'

/**
 * What the agent relay and MCP answer a failed call with. A refusal (a 4xx
 * `TRPCError`, an internal error a procedure wrote without a cause, a branded
 * domain refusal) keeps its own words; anything else is a fault and answers with
 * the generic sentence and a `reference` the caller logs the error under. Where
 * diagnostics go to clients (a server run from source) the cause chain follows
 * the sentence.
 */
export function failureForClient(
  error: unknown,
  diagnostics: boolean,
): { readonly text: string; readonly reference?: string } {
  const refusal = refusalText(error) ?? (isSchemaError(error) ? error.message : undefined)
  if (refusal !== undefined) return { text: refusal }
  const reference = crypto.randomUUID()
  const text = unexpectedFailureMessage(reference)
  return { text: diagnostics ? `${text}: ${describeError(error)}` : text, reference }
}

/**
 * A failure as text a record or a reply keeps (a spawn's reason, a chat
 * bridge's "not delivered"): a refusal's words, or for a fault the generic
 * sentence, with the error logged under its reference on `log`.
 */
export function failureTextLogged(
  error: unknown,
  log: Pick<Logger, 'warn'>,
  message: string,
  diagnostics: boolean = CLIENT_ERROR_DIAGNOSTICS,
): string {
  const answer = failureForClient(error, diagnostics)
  if (answer.reference !== undefined) {
    log.warn(message, { reference: answer.reference, err: error })
  }
  return answer.text
}
