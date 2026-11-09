/**
 * Credential-bearing app links the profile gate consumes itself (POD-2364).
 *
 * `podium://pair…` carries a one-time pairing secret and `podium://signed-in…`
 * a sign-in code. expo-router must never route them: there is no screen to
 * show, so it rendered Unmatched Route over the pairing setup, and its router
 * state would hold the secret. Both spellings iOS delivers count, the normal
 * `podium://pair?…` and the collapsed `podium:///pair?…`.
 */
const GATE_OWNED_HEADS = new Set(['pair', 'signed-in'])

export function isGateOwnedAppLink(raw: string): boolean {
  const match = /^podium:\/\/([^/?#]*)\/*([^/?#]*)/i.exec(raw.trim())
  if (!match) return false
  const head = (match[1] || match[2] || '').toLowerCase()
  return GATE_OWNED_HEADS.has(head)
}

/** expo-router's `+native-intent` hook: send gate-owned links to the root. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return isGateOwnedAppLink(path) ? '/' : path
}
