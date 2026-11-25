import { describeError } from '@podium/logger'

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

/**
 * The text a client gets for an unexpected failure: the whole cause chain where
 * diagnostics go to clients, the error's own sentence otherwise. The caller logs
 * the error itself, which keeps the chain either way.
 */
export function errorTextForClient(error: unknown, diagnostics: boolean): string {
  if (diagnostics) return describeError(error)
  return error instanceof Error ? error.message : String(error)
}
