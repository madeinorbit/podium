import { resolveProductVersion } from '@podium/protocol'
import { developmentSourceSha } from '@podium/runtime/source-version'
import { DEVELOPMENT_SOURCE_ROOT } from './modules/updates/dev-bundle'

let capturedSourceVersion: string | undefined

/** Product version for `/version` and Update: packaged channel, or dev+<sha>. Never `-dirty`. */
export function captureServerBuildVersion(
  env: NodeJS.ProcessEnv = process.env,
  sourceRoot: string = DEVELOPMENT_SOURCE_ROOT,
): string {
  const packaged = env.PODIUM_APP_VERSION ?? process.env.PODIUM_APP_VERSION
  capturedSourceVersion = packaged
    ? resolveProductVersion(packaged, undefined)
    : resolveProductVersion(undefined, developmentSourceSha(sourceRoot))
  return capturedSourceVersion
}

export function serverBuildVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.PODIUM_APP_VERSION ?? process.env.PODIUM_APP_VERSION ?? capturedSourceVersion ?? 'dev'
}
