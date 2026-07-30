/**
 * THE EDGE ADAPTER MECHANISM — permanent (POD-308).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PERMANENT HERE AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * This file is KEPT architecture. It is the answer to a problem Podium has
 * structurally and will have again at every breaking release: the client is a
 * PWA, so at any deploy some connected peers are running a build from before it,
 * and "they will refresh" is not a rollout plan. The mechanism — a registry of
 * per-version translators at the gateway, a support window it must cover, and a
 * 426 backstop for peers outside the window — is what makes a breaking wire
 * change a rollout rather than an outage.
 *
 * The CONCRETE adapters registered into it are not permanent and must not be
 * treated as though they were. Each one that translates a version the server is
 * migrating AWAY from carries {@link WireAdapterExpiry}, which is a mechanical
 * condition — "delete me when `MIN_SUPPORTED_VERSION` reaches N" — checked by
 * `scripts/audit-wire-adapters.ts` and counted by the deletion ratchet. That is
 * the difference between a scheduled deletion and a comment: a docstring saying
 * "remove after Phase 7" is satisfied by nobody reading it, whereas a gate
 * counting call sites fails the build on the day the condition arrives.
 *
 * The registry deliberately does NOT know how to translate anything. It holds
 * adapters and answers "who serves this peer"; the translations live with the
 * side that owns the frames (`apps/server/src/gateway/`), so this module has no
 * reason to change when an adapter is added or deleted — which is the property
 * that makes it permanent rather than merely long-lived.
 */

import { MIN_SUPPORTED_VERSION, SUPPORTED_WIRE_VERSIONS, WIRE_VERSION } from '../version'

/**
 * The mechanical expiry a legacy adapter carries.
 *
 * NO DATES. A date is a fact about a calendar and is satisfied by nothing; the
 * condition that actually retires an adapter is the support floor rising past
 * the version it serves. `deleteByPhase` is documentation FOR THE HUMAN and is
 * deliberately not the thing that is checked — if the two ever disagree, the
 * gate is right.
 */
export interface WireAdapterExpiry {
  /**
   * The adapter must be DELETED — not disabled, not left registered — once
   * `MIN_SUPPORTED_VERSION` reaches this value. `scripts/audit-wire-adapters.ts`
   * fails while an adapter whose condition has arrived still exists, so the act
   * of raising the floor forces every site to name a real answer.
   */
  readonly expiresWhenMinSupportedReaches: number
  /** The phase this may not outlive even if the floor has not moved. */
  readonly deleteByPhase: string
  /** Why it exists at all — read by the audit output, so the person meeting it
   *  in a failing build learns what it was for without archaeology. */
  readonly rationale: string
}

/**
 * One version's translator.
 *
 * `expiry: null` means PERMANENT, and exactly one kind of adapter may claim it:
 * the identity adapter for {@link WIRE_VERSION} itself, which is not a
 * translation at all. {@link WireVersionAdapterRegistry} enforces that — an
 * adapter for an OLDER version with `expiry: null` is a legacy translator
 * declaring itself permanent, which is the exact mistake this whole file is
 * shaped to prevent, and it is refused at registration rather than reviewed.
 */
export interface WireVersionAdapter<TFrame, TOut> {
  readonly version: number
  readonly expiry: WireAdapterExpiry | null
  /** Human-facing name; appears in telemetry and in the audit's findings. */
  readonly name: string
  /** Translate ONE canonical frame into zero or more frames of this version.
   *  Zero is legal: a version may have no way to express a frame, and dropping
   *  it explicitly here is visible, whereas a silent `undefined` is not. */
  translate(frame: TFrame): readonly TOut[]
}

export class WireVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WireVersionError'
  }
}

/** A peer outside the support window. The gateway answers 426 Upgrade Required
 *  and the peer self-updates; the body carries the window so the peer can tell
 *  its user something true rather than "connection failed". */
export interface UpgradeRequired {
  readonly status: 426
  readonly reason: 'unsupported-version'
  readonly offered: number
  readonly support: { readonly wire: number; readonly min: number }
  readonly message: string
}

export const isUpgradeRequired = (value: unknown): value is UpgradeRequired =>
  typeof value === 'object' && value !== null && (value as UpgradeRequired).status === 426

/**
 * The gateway's version→adapter table.
 *
 * Constructed with the window it must cover, so a missing adapter is a boot
 * failure rather than a runtime surprise on the first old client to connect.
 * That ordering matters: the failure this replaces is a server that advertises
 * `min: 1`, accepts a v1 peer's hello, and then has nothing to serve it —
 * indistinguishable, from the peer's side, from a broken deploy.
 */
export class WireVersionAdapterRegistry<TFrame, TOut> {
  private readonly adapters = new Map<number, WireVersionAdapter<TFrame, TOut>>()

  constructor(
    private readonly window: {
      readonly wire: number
      readonly min: number
      readonly versions: readonly number[]
    } = { wire: WIRE_VERSION, min: MIN_SUPPORTED_VERSION, versions: SUPPORTED_WIRE_VERSIONS },
  ) {}

  register(adapter: WireVersionAdapter<TFrame, TOut>): this {
    if (this.adapters.has(adapter.version)) {
      throw new WireVersionError(
        `two adapters registered for wire version ${adapter.version} ('${
          this.adapters.get(adapter.version)?.name
        }' and '${adapter.name}'). One version, one translation — a second one is a fork of the ` +
          `wire that no golden fixture can see, because both produce the same bytes today.`,
      )
    }
    if (adapter.expiry === null && adapter.version !== this.window.wire) {
      throw new WireVersionError(
        `adapter '${adapter.name}' serves wire version ${adapter.version}, which is not the current ` +
          `wire (${this.window.wire}), yet declares itself PERMANENT (expiry: null). A translator ` +
          `for a version the server is migrating away from must carry a mechanical expiry — the ` +
          `MECHANISM is permanent, the concrete adapter is not.`,
      )
    }
    if (adapter.expiry !== null && adapter.version === this.window.wire) {
      throw new WireVersionError(
        `adapter '${adapter.name}' serves the CURRENT wire version (${adapter.version}) but carries ` +
          `an expiry. The current version's adapter is the identity path and outlives every ` +
          `translation; expiring it would schedule the deletion of the wire itself.`,
      )
    }
    if (adapter.expiry !== null && adapter.expiry.expiresWhenMinSupportedReaches <= adapter.version) {
      throw new WireVersionError(
        `adapter '${adapter.name}' (wire ${adapter.version}) expires when the floor reaches ` +
          `${adapter.expiry.expiresWhenMinSupportedReaches}, which is at or below the version it ` +
          `serves — a condition that can never arrive while the adapter is needed, so it would ` +
          `never expire. It must be greater than ${adapter.version}.`,
      )
    }
    this.adapters.set(adapter.version, adapter)
    return this
  }

  /**
   * Every version the server ADVERTISES must have something to serve it.
   *
   * Call this at the composition root. The check is one-directional on purpose:
   * an adapter for a version OUTSIDE the window is not an error here — it is an
   * expired adapter, and naming that is `scripts/audit-wire-adapters.ts`'s job,
   * where the finding can carry the deletion instruction.
   */
  assertCoversWindow(): void {
    const missing = this.window.versions.filter((version) => !this.adapters.has(version))
    if (missing.length > 0) {
      throw new WireVersionError(
        `the support window [${this.window.min}, ${this.window.wire}] advertises version(s) ` +
          `${missing.join(', ')} with no adapter registered. A peer offering one would be accepted ` +
          `at the handshake and then served nothing, which from its side is a broken deploy.`,
      )
    }
  }

  /** Adapters whose expiry condition has ARRIVED, given a support floor. The
   *  audit's input; also usable as a boot assertion. */
  expired(min: number = this.window.min): readonly WireVersionAdapter<TFrame, TOut>[] {
    return [...this.adapters.values()].filter(
      (adapter) => adapter.expiry !== null && min >= adapter.expiry.expiresWhenMinSupportedReaches,
    )
  }

  /** Resolve the translator for a peer's agreed version, or the 426 backstop. */
  resolve(version: number): WireVersionAdapter<TFrame, TOut> | UpgradeRequired {
    const adapter = this.adapters.get(version)
    if (adapter !== undefined) return adapter
    return upgradeRequired(version, { wire: this.window.wire, min: this.window.min })
  }

  versions(): readonly number[] {
    return [...this.adapters.keys()].sort((a, b) => a - b)
  }
}

export function upgradeRequired(
  offered: number,
  support: { wire: number; min: number } = { wire: WIRE_VERSION, min: MIN_SUPPORTED_VERSION },
): UpgradeRequired {
  const direction = offered < support.min ? 'too old' : 'too new'
  return {
    status: 426,
    reason: 'unsupported-version',
    offered,
    support,
    message:
      `wire version ${offered} is ${direction}; this server serves ${support.min}–${support.wire}. ` +
      `Update and reconnect.`,
  }
}
