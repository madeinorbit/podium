/**
 * Where a pasted install command fetches `install.sh` from, per release channel.
 *
 * Stable goes through `podium.do/install.sh`: the website serves the installer from the current
 * stable release (GitHub's `releases/latest`), so the command people paste is the same one the
 * website and docs show, and it never names a release path. A rolling channel (`edge`, `dev`)
 * publishes onto a standing tag named after itself, so its GitHub URL is already constant;
 * podium.do has no address for those, so they stay on GitHub.
 *
 * Shared by the Add machine join command (`apps/server/src/hub/machines-join.ts`) and the
 * fresh-VPS onboarding command (`./vps-bootstrap.ts`), so the two cannot drift apart.
 */
export type InstallerChannel = 'stable' | 'edge' | 'dev'

export const STABLE_INSTALLER_URL = 'https://podium.do/install.sh'

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'

export function installerUrl(channel: InstallerChannel): string {
  return channel === 'stable'
    ? STABLE_INSTALLER_URL
    : `${RELEASE_BASE}/download/${channel}/install.sh`
}
