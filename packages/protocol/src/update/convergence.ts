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
import { isHeadlessPlatform } from './platforms'
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

/**
 * EVERY PLATFORM THIS TARGET ACTUALLY CARRIES BYTES FOR.
 *
 * The keys of `artifacts.headless.platforms`, plus every alternative's, in the
 * order they are offered and deduplicated — the same set {@link planConvergence}
 * walks when it selects, read as a list rather than probed one key at a time.
 *
 * It lives here, in the protocol, because two very different questions turn on
 * it and neither may answer it for itself: the machine asking "is there
 * anything here for me", and the SERVER asking "should I offer this machine
 * anything at all" (POD-2783). A second copy of this rule on the server is
 * exactly how an offer and the refusal that follows it get to disagree.
 *
 * A delivery kind with no `platforms` map (the retired `git`) contributes
 * nothing rather than a guess.
 */
export function targetPlatforms(target: UpdateTarget): string[] {
  const artifacts = [
    ...(target.artifacts.headless ? [target.artifacts.headless] : []),
    ...(target.artifacts.headlessAlternatives ?? []),
  ]
  const platforms: string[] = []
  for (const artifact of artifacts) {
    const keyed = (artifact as { platforms?: Record<string, unknown> }).platforms
    if (!keyed) continue
    for (const platform of Object.keys(keyed)) {
      if (!platforms.includes(platform)) platforms.push(platform)
    }
  }
  return platforms
}

/**
 * WHAT A REFUSING MACHINE WRITES DOWN (POD-2783).
 *
 * `cannot converge: unsupported-platform` was true and unusable. It named the
 * check that failed and nothing a person could act on, so the copy above it
 * guessed: it sent the operator to check that the release included the
 * machine's platform, when the release is immutable and the operator has
 * nothing to fix.
 *
 * TWO DIFFERENT REFUSALS WERE WEARING ONE TOKEN, and their remedies are
 * opposite:
 *
 *  - The platform is one Podium publishes for, and this particular release
 *    predates the machine — a dev target's platform list is built from the
 *    fleet AT MINT TIME (`fleetHeadlessPlatforms`), so a machine that enrolled
 *    afterwards is simply not in it. Nothing is broken and nothing needs
 *    fixing; the next release built will carry it.
 *  - The platform is one Podium publishes for NOBODY (Windows today). No
 *    release will ever carry it, and copy promising a later one would be the
 *    same confident lie in a new place.
 *
 * The sentence states only what this machine can prove — its own platform, and
 * what the release in its hand actually contains. The "and therefore" belongs
 * to the reader that knows the fleet, which is the server's copy table.
 */
export function convergenceRefusal(
  plan: Extract<ConvergencePlan, { action: 'cannot' }>,
  ctx: { platform: string; target: UpdateTarget },
): string {
  if (plan.reason !== 'unsupported-platform') return `cannot converge: ${plan.reason}`
  const version = ctx.target.version
  if (!isHeadlessPlatform(ctx.platform)) {
    return (
      'cannot converge: platform-not-published — Podium publishes no package for ' +
      `${ctx.platform}, so ${version} contains none and no later release will.`
    )
  }
  const carried = targetPlatforms(ctx.target)
  const built = carried.length > 0 ? carried.join(', ') : 'no platform at all'
  return (
    `cannot converge: unsupported-platform — ${version} contains no package for ${ctx.platform}. ` +
    `It was built for ${built}.`
  )
}
