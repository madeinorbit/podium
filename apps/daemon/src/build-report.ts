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

export function deliveryCaps(installKind: PeerBuild['installKind']): string[] {
  return installKind === 'source'
    ? ['update.delivery.git']
    : ['update.delivery.feed', 'update.delivery.bundle']
}
