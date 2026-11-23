/**
 * PAIRING LINKS NEVER REACH THE ROUTER (POD-6913).
 *
 * The OS hands a pairing link (`podium://pair?url=…`, `podium://pair/<envelope>`,
 * or the HTTPS `…/mobile#pair=…` URL) to the app twice: to React Native's
 * `Linking`, where the profile gate parses it and opens the pairing flow, and
 * to expo-router, which resolved it as the path `/pair` — a route that does not
 * exist — and painted "Unmatched Route" over the gate. The link also carries a
 * one-time secret that has no business in router state or history.
 *
 * `app/+native-intent.ts` runs this before the router resolves any OS link,
 * and the gate, which reads the raw URL from `Linking`, stays the link's only
 * consumer. A cold pairing link starts the router at the root. A warm one
 * moves the router nowhere: a navigation at the root remounts the root
 * layout, gate included, and would discard the pairing it is opening.
 */

/** Whether the OS handed the app a pairing link rather than a place to go. */
export function isPairingSystemPath(path: string): boolean {
  const raw = path.trim()
  // `podium:` is not a special scheme, so `podium://pair…` names `pair` as the
  // host and `podium:///pair…` puts it in the path; the parser accepts both
  // and is case-insensitive about the scheme.
  const custom = /^podium:\/*(.*)$/i.exec(raw)
  if (custom) return /^pair(?:[/?#]|$)/i.test(custom[1] ?? '')
  return raw.includes('#pair=')
}

/**
 * The router path for an OS link: unchanged, unless it is a pairing link. That
 * starts a cold app at the root and leaves a running one where it is (`null`).
 */
export function routeForSystemPath(path: string, initial: boolean): string | null {
  if (!isPairingSystemPath(path)) return path
  return initial ? '/' : null
}
