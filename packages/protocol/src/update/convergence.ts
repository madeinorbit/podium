/**
 * WHAT A MACHINE SHOULD DO ABOUT ITS TARGET. Pure, so the whole decision is
 * testable without a socket, a filesystem, or a network.
 *
 * TARGET EQUALITY, NOT `isNewer`. The server is authority, so the question is
 * "am I running what I was told to run", not "is there something newer". Those
 * differ in exactly one place and it is the place that matters: a DOWNGRADE. A
 * planner that only ever moves forward makes rollback structurally impossible.
 *
 * Versions are compared as STRINGS. `appVersion` is a label and may be
 * `dev+<sha>`, which has no ordering at all. Anything that tries to sort these
 * is wrong.
 */
import type { UpdateArtifact, UpdateTarget } from './target'

type PlatformAsset = Extract<UpdateArtifact, { delivery: 'feed' }>['platforms'][string]

/**
 * A plan contains the exact platform asset selected for this daemon.
 *
 * `delivery` survives the retirement of `bundle` and `git` as a single-valued
 * field rather than being deleted: it is the axis the caps negotiation and the
 * fleet's `cannot: unsupported-delivery` refusal are both phrased in, and a
 * later delivery kind (a differential patch, say) belongs here rather than in a
 * second parallel vocabulary.
 */
export type ConvergencePlan =
  | { action: 'already-current' }
  | { action: 'converge'; delivery: 'feed'; asset: PlatformAsset }
  | {
      action: 'cannot'
      reason: 'no-artifact' | 'unsupported-delivery' | 'unsupported-platform'
    }

const CAP_FOR_DELIVERY: Record<UpdateArtifact['delivery'], string> = {
  feed: 'update.delivery.feed',
}

export function planConvergence(ctx: {
  current: string
  target: UpdateTarget
  caps: readonly string[]
  platform: string
  /** Re-deliver equal-version bytes for an explicit repair request. */
  repair?: boolean
}): ConvergencePlan {
  // Equality FIRST. A machine already on the target is fine regardless of what
  // it could or could not have downloaded, except when a human explicitly asked
  // to replace those bytes because their health is no longer trusted.
  if (ctx.current === ctx.target.version && ctx.repair !== true) {
    return { action: 'already-current' }
  }

  const artifacts = [
    ...(ctx.target.artifacts.headless ? [ctx.target.artifacts.headless] : []),
    ...(ctx.target.artifacts.headlessAlternatives ?? []),
  ]
  if (artifacts.length === 0) return { action: 'cannot', reason: 'no-artifact' }

  let supportsOfferedDelivery = false
  for (const artifact of artifacts) {
    if (!ctx.caps.includes(CAP_FOR_DELIVERY[artifact.delivery])) continue
    supportsOfferedDelivery = true

    // Never select another platform's bytes. A signed, digest-matching binary
    // for the wrong architecture is still a bricked daemon. Continue only to
    // another explicitly offered delivery, never to another platform's asset.
    const asset = artifact.platforms[ctx.platform]
    if (asset) return { action: 'converge', delivery: artifact.delivery, asset }
  }

  return {
    action: 'cannot',
    reason: supportsOfferedDelivery ? 'unsupported-platform' : 'unsupported-delivery',
  }
}
