import { type PeerBuild, wireSchemaDigest } from '@podium/protocol'

export function buildReport(
  env: NodeJS.ProcessEnv,
  installDir: string | undefined,
): PeerBuild {
  return {
    appVersion: env.PODIUM_APP_VERSION ?? 'dev',
    wireSchemaDigest: wireSchemaDigest(),
    installKind: installDir ? 'installed' : 'source',
  }
}

export function deliveryCaps(installKind: PeerBuild['installKind']): string[] {
  return installKind === 'source'
    ? ['update.delivery.git']
    : ['update.delivery.feed', 'update.delivery.bundle']
}
