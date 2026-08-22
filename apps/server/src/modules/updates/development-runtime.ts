import { isAbsolute } from 'node:path'

export const DEVELOPMENT_SOURCE_ROOT_ENV = 'PODIUM_DEV_SOURCE_ROOT'

export interface DevelopmentRuntime {
  /** Process identity decides install/restart behavior, never publisher availability. */
  runningFromSource: boolean
  /** A checkout to mint from, whether this process itself is source or packaged. */
  publisherSourceRoot: string | undefined
}

/**
 * Keep two previously-conflated facts separate.
 *
 * A packaged development install is an ordinary installed consumer for swap,
 * rollback and handover purposes. It may also be the dev publisher when its
 * service explicitly points at a checkout. Production installs omit that
 * opt-in and therefore never inspect or build arbitrary source on the host.
 */
export function resolveDevelopmentRuntime(input: {
  env?: NodeJS.ProcessEnv
  packagedVersion: string | undefined
  sourceRunRoot: string
}): DevelopmentRuntime {
  const env = input.env ?? process.env
  const runningFromSource = input.packagedVersion === undefined
  const configured = env[DEVELOPMENT_SOURCE_ROOT_ENV]?.trim()
  if (configured && !isAbsolute(configured)) {
    throw new Error(`${DEVELOPMENT_SOURCE_ROOT_ENV} must be an absolute checkout path`)
  }
  return {
    runningFromSource,
    publisherSourceRoot: configured || (runningFromSource ? input.sourceRunRoot : undefined),
  }
}
