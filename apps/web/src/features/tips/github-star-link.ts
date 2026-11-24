export const PODIUM_REPO_URL = 'https://github.com/madeinorbit/podium'

/** Uses the existing external-link dispatch on desktop, or a new browser tab. */
export function openPodiumRepo(): void {
  window.open(PODIUM_REPO_URL, '_blank', 'noopener,noreferrer')
}
