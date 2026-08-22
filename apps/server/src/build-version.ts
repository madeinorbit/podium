import { resolveProductVersion, sourceDigest } from '@podium/protocol'
import { developmentSourceSha } from '@podium/runtime/source-version'
import { DEVELOPMENT_SOURCE_ROOT } from './modules/updates/dev-bundle'

let capturedSourceVersion: string | undefined
let capturedSourceDigest: string | undefined

/** Product version for `/version` and Update: packaged channel, or dev+<sha>. Never `-dirty`. */
export function captureServerBuildVersion(
  env: NodeJS.ProcessEnv = process.env,
  sourceRoot: string = DEVELOPMENT_SOURCE_ROOT,
): string {
  const packaged = env.PODIUM_APP_VERSION ?? process.env.PODIUM_APP_VERSION
  capturedSourceDigest = sourceDigest(
    env.PODIUM_SOURCE_SHA ??
      process.env.PODIUM_SOURCE_SHA ??
      (packaged ? undefined : developmentSourceSha(sourceRoot)),
  )
  capturedSourceVersion = packaged
    ? resolveProductVersion(packaged, undefined)
    : resolveProductVersion(undefined, capturedSourceDigest)
  return capturedSourceVersion
}

export function serverBuildVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.PODIUM_APP_VERSION ?? process.env.PODIUM_APP_VERSION ?? capturedSourceVersion ?? 'dev'
}

/** Source identity captured with the process, independent of its product-version label. */
export function serverBuildSourceDigest(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    sourceDigest(env.PODIUM_SOURCE_SHA) ??
    sourceDigest(process.env.PODIUM_SOURCE_SHA) ??
    capturedSourceDigest
  )
}
