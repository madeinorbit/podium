/**
 * WHICH READ PATH THIS CLIENT RUNS — and the one case where the flag does not
 * get to decide (POD-376).
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND WHY IT IS A FUNCTION RATHER THAN A CONVENTION
 * ---------------------------------------------------------------------------
 *
 * The brief's fourth acceptance clause: *the flag cannot select an unscoped read
 * path against a scoped authority, and that restriction is enforced in code.*
 *
 * The load-bearing enforcement is SERVER-SIDE — `WireFeedEdge.attach` refuses a
 * peer whose wire cannot express `evict` when the policy is `per-principal`, so
 * an off-flag client against a scoped server is refused whatever this function
 * says. That refusal is what makes the property true. This function exists for a
 * different reason: without it, the flag-off client would discover the refusal as
 * a 426 at connect time and report it as a version problem, which is a true
 * mechanism producing a false explanation.
 *
 * So the client resolves the same rule, from the grade the server advertises on
 * `/version`, BEFORE it constructs anything. And it does not silently "upgrade"
 * either: the result carries a `reason`, and a flag that quietly means something
 * other than what it says is its own defect. Settings can render "off is not
 * available on this server, and here is why" instead of a toggle that appears to
 * work and does not.
 *
 * ---------------------------------------------------------------------------
 * WHY `device-unscoped` IS THE PERMISSIVE DEFAULT, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * An unknown or absent grade resolves to `device-unscoped`. That is the fail-OPEN
 * direction and it is chosen with the reason written down rather than by
 * omission: this function is NOT the security boundary — the server's refusal is
 * — and defaulting the other way would force every client that cannot read the
 * probe (an old server, a proxy that ate the field, a stripped-down test
 * assembly) onto a path that server may not serve at all. A client wrong in this
 * direction is refused by the server and told why. A client wrong in the other
 * direction cannot connect to a server that would have served it perfectly well.
 *
 * The rule this file must never take on is deciding VISIBILITY. It decides which
 * of two client implementations reads the feed; the feed's contents are the
 * Authority's, always.
 */

/** The grade as `/version` reports it. Widened to `string` at the boundary
 *  because it arrives over the network and an unrecognised value must be handled,
 *  not asserted away. */
export type AdvertisedGrade = string

export type ReplicaPath =
  /** Today's shipped path: wire v1, TanStack replica. */
  | 'legacy'
  /** The kernel Replica + Outbox over IndexedDB, on the v2 feed. */
  | 'kernel'
  /** Kernel primary, with the legacy path running read-only beside it. */
  | 'kernel-with-shadow'

export type ReplicaModeReason =
  /** The flags said so and nothing overrode them. */
  | 'as-configured'
  /**
   * The flag asked for the legacy path and the server evaluates visibility per
   * principal. Not honourable: v1 cannot express `evict`, so the server would
   * refuse the connection anyway — and would have to, because a path that renders
   * a row it cannot later withdraw honestly is a visibility bypass with a delay.
   */
  | 'legacy-refused-scoped-authority'

export interface ReplicaMode {
  readonly path: ReplicaPath
  readonly reason: ReplicaModeReason
  /** True when the resolved path is NOT what the flags asked for. Surfaced in
   *  Settings; never silently swallowed. */
  readonly overridden: boolean
}

export interface ResolveReplicaModeInput {
  /** `features.state` → `kernel-replica`. */
  readonly kernelReplicaEnabled: boolean
  /** `features.state` → `kernel-replica-shadow`. */
  readonly shadowEnabled: boolean
  /** `/version` → `feedScoping`. */
  readonly serverGrade: AdvertisedGrade | undefined
}

/**
 * PURE, and total over its input. No fetch, no storage, no clock — so the rule
 * can be exercised across the whole matrix in a unit test and there is nothing
 * left for an integration to hide.
 */
export function resolveReplicaMode(input: ResolveReplicaModeInput): ReplicaMode {
  const scoped = input.serverGrade === 'per-principal'

  if (input.kernelReplicaEnabled) {
    // THE SHADOW FLAG IS IGNORED AGAINST A SCOPED AUTHORITY, for the same reason
    // the off state is: the shadow path IS the legacy path, on a second wire-v1
    // connection, and that connection would be refused. Running the cutover
    // without its comparison is the honest outcome; running it with a comparison
    // whose second connection is dead would report "no divergence" from a path
    // that never received a row — the rubber stamp the whole basis document
    // exists to prevent.
    if (input.shadowEnabled && !scoped) {
      return { path: 'kernel-with-shadow', reason: 'as-configured', overridden: false }
    }
    if (input.shadowEnabled && scoped) {
      return { path: 'kernel', reason: 'legacy-refused-scoped-authority', overridden: true }
    }
    return { path: 'kernel', reason: 'as-configured', overridden: false }
  }

  if (scoped) {
    return { path: 'kernel', reason: 'legacy-refused-scoped-authority', overridden: true }
  }
  return { path: 'legacy', reason: 'as-configured', overridden: false }
}

/** Human-facing explanation for an overridden mode. Empty for a mode that was
 *  honoured — a caller rendering this must show nothing when nothing happened. */
export function explainReplicaMode(mode: ReplicaMode): string {
  if (!mode.overridden) return ''
  return (
    'This server evaluates visibility per principal, so a row can leave your view without being ' +
    'deleted. The outgoing read path has no way to express that difference, and showing you a row ' +
    'that cannot later be withdrawn honestly is not a fallback. The kernel replica is in use ' +
    'regardless of this setting.'
  )
}
