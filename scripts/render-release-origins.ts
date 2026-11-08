/** Generate the POSIX bootstrap adapter from the shared release policy. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PRIMARY_RELEASE_ORIGIN,
  RELEASE_ORIGINS,
  RELEASE_REDIRECT_HOPS,
  releaseChannelPath,
  releaseUrl,
} from '../packages/runtime/src/release-origins'

export function installerOriginPolicy(): string {
  return [
    '# BEGIN GENERATED RELEASE ORIGINS — bun scripts/render-release-origins.ts',
    'release_bases() {',
    '  case "$CHANNEL" in',
    ...(['stable', 'edge', 'dev'] as const).map(
      (channel) =>
        `    ${channel}) printf '%s\\n' ${RELEASE_ORIGINS.map((origin) => `'${releaseUrl(releaseChannelPath(channel), origin).replace(/\/$/, '')}'`).join(' ')} ;;`,
    ),
    '  esac',
    '}',
    'release_hosts() {',
    '  case "$1" in',
    ...RELEASE_ORIGINS.map(
      (origin) => `    ${origin.baseUrl}*) printf '%s' '${origin.redirectHosts.join(' ')}' ;;`,
    ),
    "    *) printf '%s' '' ;;",
    '  esac',
    '}',
    `RELEASE_AUTH_HOST='${new URL(PRIMARY_RELEASE_ORIGIN.baseUrl).hostname}'`,
    `RELEASE_REDIRECT_HOPS=${RELEASE_REDIRECT_HOPS}`,
    '# END GENERATED RELEASE ORIGINS',
  ].join('\n')
}

if (import.meta.main) {
  const path = fileURLToPath(new URL('../install.sh', import.meta.url))
  const text = readFileSync(path, 'utf8')
  writeFileSync(
    path,
    text.replace(/# BEGIN GENERATED RELEASE ORIGINS[\s\S]*?# END GENERATED RELEASE ORIGINS/, () =>
      installerOriginPolicy(),
    ),
  )
}
