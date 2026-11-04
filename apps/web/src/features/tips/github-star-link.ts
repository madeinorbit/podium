export const PODIUM_REPO_URL = 'https://github.com/madeinorbit/podium'

/** Opens the repo page: the system browser on desktop, a new tab on the web. */
export function openPodiumRepo(): void {
  window.open(PODIUM_REPO_URL, '_blank', 'noopener,noreferrer')
}
