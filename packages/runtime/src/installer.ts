/** Installer addresses come from the shared public release policy. */
import { RELEASE_ORIGINS, releaseChannelPath, releaseUrl } from './release-origins'

export { STABLE_INSTALLER_URL } from './release-origins'
export type InstallerChannel = 'stable' | 'edge' | 'dev'

export function installerUrls(channel: InstallerChannel): string[] {
  return RELEASE_ORIGINS.map((origin) =>
    releaseUrl(releaseChannelPath(channel) + 'install.sh', origin),
  )
}

export function installerUrl(channel: InstallerChannel): string {
  return installerUrls(channel)[0] as string
}
