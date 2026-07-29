/**
 * The optimistic-overlay REDUCER SEAM — declared here, implemented elsewhere.
 *
 * POD-372 derives overlays from contract reducers and POD-351 ships the first
 * real contract + reducer. This file therefore defines the PORT and nothing else:
 * inventing a reducer vocabulary here would guarantee two competing ones later,
 * which is the specific failure POD-349 names (anything left undecided becomes N
 * divergent local decisions).
 *
 * Two properties the Replica relies on and neither invents:
 *
 * 1. **The overlay is DERIVED, never stored twice** (ADR 4 D7 — normalization law
 *    and derivation locality). It is a function of (authoritative base, pending
 *    commands). The Replica never persists an overlay row, which is also why a
 *    re-bootstrap cannot lose one: the outbox survives every rung (ADR 2 D7), so
 *    the overlay simply recomputes.
 * 2. **Retirement is EXACT, via envelope provenance** — a change is "my own write
 *    coming back" when its `causationId`/`mutationId` matches a pending command
 *    (ADR 2 D8), never when its value looks similar. Value comparison would be the
 *    replica arbitrating.
 */

/**
 * A queued client command, from the Replica's point of view. `command` is
 * deliberately `unknown`: the command contract is ADR 3's and POD-351's, and the
 * Replica must not be able to interpret it — interpreting it would be arbitration.
 */
export interface PendingMutation {
  readonly mutationId: string
  readonly entity: string
  readonly entityId: string
  readonly command: unknown
}

export interface OptimisticOverlayPort {
  /** Pending commands for this entity, in author order. Supplied by the outbox (POD-370). */
  pending(entity: string, entityId: string): readonly PendingMutation[]
  /**
   * The reducer seam (POD-372/POD-351). `base` is `undefined` for an optimistic
   * create. Returning `undefined` means "optimistically absent".
   */
  reduce(base: unknown | undefined, command: unknown): unknown
  /**
   * Called once per applied change that carries provenance, so the outbox can
   * retire the matching entry. The Replica reports the fact; it does not decide
   * what the outbox should do with it.
   */
  retire(match: {
    readonly entity: string
    readonly entityId: string
    readonly causationId?: string
    readonly mutationId?: string
  }): void
}
