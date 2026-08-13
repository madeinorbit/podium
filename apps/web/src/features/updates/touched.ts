import type { UpdateTarget } from '@podium/protocol'

export interface TouchedContext {
  localDigests: { app?: string }
  target: UpdateTarget
  fleetBehind: number
  serverBehind: boolean
  /** A source-host dev redeploy rebuilds the browser bundle with the server. */
  sourceAppFollowsServer?: boolean
  /**
   * The phone website this server serves is built from a different commit than
   * the target (POD-1980).
   *
   * Read from the SERVER's reading of its own disk, not from a digest this page
   * fetched: a page cannot tell a phone export that is stale from one that was
   * never built, and those two need opposite answers. Absent here means there is
   * no phone website to move, which is not the same as one that is current.
   */
  phoneBehind?: boolean
}

export interface TouchedPlaces {
  app: boolean
  server: boolean
  machines: boolean
  phone: boolean
}

/**
 * A release label is shared by every surface, but the bytes behind that label
 * are not. Compare the local web digest before telling an operator that this
 * app will change, and fail toward showing a place when its local digest is not
 * known.
 */
export function computeTouched(ctx: TouchedContext): TouchedPlaces {
  const targetDigest = ctx.target.artifacts.web?.digest
  return {
    app:
      (targetDigest !== undefined && ctx.localDigests.app !== targetDigest) ||
      (ctx.sourceAppFollowsServer === true && ctx.serverBehind),
    server: ctx.serverBehind,
    machines: ctx.fleetBehind > 0,
    phone: ctx.phoneBehind === true,
  }
}
