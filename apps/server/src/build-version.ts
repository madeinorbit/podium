import { developmentSourceVersion } from '@podium/runtime/source-version'
import { DEVELOPMENT_SOURCE_ROOT } from './modules/updates/dev-bundle'

let capturedSourceVersion: string | undefined

/** Capture once at process boot: a checkout moving underneath a running server is an update, not this build. */
export function captureServerBuildVersion(
  env: NodeJS.ProcessEnv = process.env,
  sourceRoot: string = DEVELOPMENT_SOURCE_ROOT,
): string {
  capturedSourceVersion =
    env.PODIUM_APP_VERSION ?? process.env.PODIUM_APP_VERSION ?? developmentSourceVersion(sourceRoot)
  return capturedSourceVersion
}

export function serverBuildVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.PODIUM_APP_VERSION ?? process.env.PODIUM_APP_VERSION ?? capturedSourceVersion ?? 'dev'
}
