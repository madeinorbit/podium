import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type PeerBuild, wireSchemaDigest } from '@podium/protocol'
import { developmentSourceVersion } from '@podium/runtime/source-version'

const DEVELOPMENT_SOURCE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

export function buildReport(
  env: NodeJS.ProcessEnv,
  installDir: string | undefined,
  sourceVersion?: string,
): PeerBuild {
  return {
    appVersion:
      env.PODIUM_APP_VERSION ??
      (installDir ? 'dev' : (sourceVersion ?? developmentSourceVersion(DEVELOPMENT_SOURCE_ROOT))),
    wireSchemaDigest: wireSchemaDigest(),
    installKind: installDir ? 'installed' : 'source',
  }
}

export interface DaemonBootBuild {
  build: PeerBuild
  installDir: string | undefined
}

/** Capture one build identity before daemon boot or reconnect work can move the checkout. */
export function captureDaemonBootBuild(
  env: NodeJS.ProcessEnv,
  execPath: string,
  sourceRoot: string = DEVELOPMENT_SOURCE_ROOT,
): DaemonBootBuild {
  const installDir =
    env.PODIUM_HOME ?? (/(?:^|[\\/])podium$/.test(execPath) ? dirname(execPath) : undefined)
  const sourceVersion =
    installDir || env.PODIUM_APP_VERSION ? undefined : developmentSourceVersion(sourceRoot)
  return { build: buildReport(env, installDir, sourceVersion), installDir }
}

export function deliveryCaps(installKind: PeerBuild['installKind']): string[] {
  return installKind === 'source'
    ? ['update.delivery.git']
    : ['update.delivery.feed', 'update.delivery.bundle']
}
