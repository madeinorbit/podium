import type { ServedWebIdentity, ServerVersion } from '@podium/protocol'

/**
 * WHICH OF THIS SERVER'S WEBSITES IS THIS PAGE — if either (POD-2721).
 *
 * `/version` describes two dists: `web` (the desktop app, a Vite build) and
 * `mobileWeb` (the phone export, Metro). Comparing a page's entry chunk against
 * the wrong one is worse than not comparing at all: the two toolchains will
 * never produce the same hash, so the answer would be `replaced` forever and the
 * reload it offers would never clear it. That is exactly the shape POD-2608
 * already paid for, arriving by a new route.
 *
 * There is also a third case, and it is the one that is easy to miss: a page
 * whose assets did not come from this server AT ALL. A desktop shell running its
 * own baked `tauri://` UI against a remote Podium, and an iteration-mode page
 * served from source by Vite in front of an installed server, are both talking
 * to an origin whose dist they were never loaded from. Their entry hash differs
 * from the served one permanently and correctly, and reloading cannot change it
 * — the assets are somewhere else.
 *
 * So the question is not "which dist is closest" but "was this page served by
 * the origin we are asking". Same origin is what makes the comparison mean
 * anything; the path then says which of the two dists it belongs to. Anything
 * else answers `undefined`, and `classifyAssets` turns that into `unknown`.
 *
 * IN `lib/` AND NOT IN EITHER FEATURE, for the same reason `reload-budget` is:
 * the callers are `features/setup` (the boot and reconnect check) and
 * `features/updates` (the panel's local fact), and a feature may not import
 * another feature (features/README.md). This is the shared layer under them.
 */
export function servedWebsiteForPage(
  server: ServerVersion,
  httpOrigin: string,
  location: Pick<Location, 'origin' | 'pathname'> = window.location,
): ServedWebIdentity | undefined {
  let asking: string
  try {
    asking = new URL(httpOrigin, location.origin).origin
  } catch {
    return undefined
  }
  // A baked shell (`tauri://…`) and a Vite source server are both a different
  // origin from the server they talk to, which is the whole test.
  if (asking !== location.origin) return undefined
  return location.pathname.startsWith('/mobile') ? server.mobileWeb : server.web
}
