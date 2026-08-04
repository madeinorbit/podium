import type { UpdateTarget } from '@podium/protocol'

export interface TouchedContext {
  localDigests: { app?: string }
  target: UpdateTarget
  fleetBehind: number
  serverBehind: boolean
}

export interface TouchedPlaces {
  app: boolean
  server: boolean
  machines: boolean
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
    app: targetDigest !== undefined && ctx.localDigests.app !== targetDigest,
    server: ctx.serverBehind,
    machines: ctx.fleetBehind > 0,
  }
}
