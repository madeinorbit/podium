/**
 * FEED IDENTITY — `(feedId, epoch)` minting and persistence (ADR 2 D1).
 *
 * RE-HOMED ONTO POD-306 BY POD-305, and built here rather than passed onward.
 * The reason is the one the coordinator named: without a real minting and
 * persistence path, the Replica's rung 4 (`epoch-mismatch`) is reachable ONLY
 * from a scripted fixture that hands the replica a frame with a different epoch
 * in it. A conformance case built on that proves the replica compares two strings
 * — it proves nothing about whether an authority ever produces two different
 * strings, which is the half that actually fails in production.
 *
 * ---------------------------------------------------------------------------
 * WHY A COUNTER IS FORBIDDEN, AND WHY THAT IS ENFORCED HERE RATHER THAN NOTED
 * ---------------------------------------------------------------------------
 *
 * D1 spends its longest passage on this and it is worth restating in one breath,
 * because the mistake is attractive and its failure is silent:
 *
 * > The epoch lives *in the database*, so restoring a backup restores the **old
 * > epoch value**. A counter therefore bumps from the restored value. Restore a
 * > backup stamped `epoch=3` → bump → `4`. Now restore *the same backup again*
 * > → it is `epoch=3` again → bump → **`4` again** — a different timeline wearing
 * > an epoch that clients have already accepted.
 *
 * A replica that has accepted the first `4` sees the second `4`, finds no
 * mismatch, and applies a foreign timeline's changes onto its own cache. There is
 * no error, no gap, and no heal: the check exists, its refusing arm never fires,
 * and every test of it passes. That is the exact fails-open shape this run has
 * paid for three times over.
 *
 * So `assertOpaqueEpoch` REFUSES a decimal-integer epoch outright. The mint is
 * injected (the kernel may not name a crypto or uuid library — it runs in a
 * browser, a worker and on the server), which means the one thing that can go
 * wrong is a caller injecting `() => String(++n)`. Refusing that shape at the
 * boundary turns "we agreed to use a ULID" from a code-review convention into a
 * throw at the moment the wrong thing is wired.
 *
 * NO ORDERING. Epochs are compared by EQUALITY ONLY (D1: "a replica only ever
 * asks 'is this the same generation I have?'"). Nothing here returns a
 * comparison, and there is no `>` on an epoch anywhere in this package — if a
 * consumer ever needs to know which of two epochs is newer, the design has
 * drifted back to the counter.
 */

/** ADR 2 D1 — a feed's identity. A cursor is meaningless without it. */
export interface FeedIdentity {
  /** Which authority's log this is. Stable for the life of the database. */
  readonly feedId: string
  /** The current seq-continuity generation. Opaque, never reused, never ordered. */
  readonly epoch: string
}

/**
 * Why the epoch was rolled. Recorded because D1's hard case is that there is NO
 * restore code path to hook — a restore is `cp podium.db` — so the cause is the
 * only evidence available afterwards about which generation is which.
 */
export type EpochBumpCause =
  /** [spec:SP-4428]'s backup-restore runbook: the operator declared a restore. */
  | 'restore'
  /** The log's max seq moved backwards, or a gap appeared in it. */
  | 'seq-discontinuity'
  /** The change log was truncated or rebuilt from scratch. */
  | 'log-reset'

/**
 * Durable storage for the identity. ONE row; there is no history to keep, since
 * an epoch is never compared to a previous one.
 *
 * A port rather than a table, for the reason the whole kernel is ports: this
 * module must be instantiable in a test with a plain object, and the SQLite
 * shape of it belongs to `../adapters/sqlite`.
 */
export interface FeedIdentityStore {
  /** The persisted identity, or `null` on a database that has never had one. */
  readIdentity(): FeedIdentity | null
  /** Persist. MUST be durable before the caller publishes a frame carrying it. */
  writeIdentity(identity: FeedIdentity): void
}

/** Injected opaque-id source — a ULID or UUID v4 generator. Never a counter. */
export type OpaqueIdMint = () => string

export class FeedIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedIdentityError'
  }
}

/**
 * The D1 guard, applied to every minted value before it can be persisted.
 *
 * Deliberately narrow: it refuses what D1 names as the wrong thing (a decimal
 * counter) and what is trivially broken (empty), and it does NOT try to validate
 * ULID or UUID syntax. A format check would be a second, competing definition of
 * "an opaque id" that this package has no business owning, and the failure it
 * would catch (a well-formed id from a bad source) is not the failure D1 is
 * about.
 */
export function assertOpaqueEpoch(epoch: string): void {
  if (epoch === '') {
    throw new FeedIdentityError('an epoch may not be empty')
  }
  if (/^\d+$/.test(epoch)) {
    throw new FeedIdentityError(
      `epoch '${epoch}' is a decimal integer, so it is a COUNTER. ADR 2 D1 forbids this: a counter ` +
        `re-collides across repeated restores of one backup, handing a different timeline an epoch ` +
        `clients have already accepted. Inject a ULID or UUID mint instead.`,
    )
  }
}

/**
 * Mints on first use, persists, and rolls the epoch on demand.
 *
 * Constructing this does NOT write. The identity is minted lazily on the first
 * `current()`, so a read-only consumer of a fresh database does not silently
 * create a feed — and, more usefully, so a test can observe the "no identity
 * persisted yet" state that a first-boot replica actually meets.
 */
export class FeedIdentityRegistry {
  private cached: FeedIdentity | null = null

  constructor(
    private readonly store: FeedIdentityStore,
    private readonly mint: OpaqueIdMint,
  ) {}

  /**
   * The identity this authority publishes, minting and persisting one if the
   * database has never had one.
   *
   * Reads THROUGH to the store on a cache miss rather than assuming the cache is
   * authoritative, which is what makes "survives a restart" a property a test can
   * assert by building a second registry over the same store.
   */
  current(): FeedIdentity {
    const cached = this.cached
    if (cached !== null) return cached
    const persisted = this.store.readIdentity()
    if (persisted !== null) {
      assertOpaqueEpoch(persisted.epoch)
      this.cached = persisted
      return persisted
    }
    const minted: FeedIdentity = { feedId: this.mint(), epoch: this.mint() }
    assertOpaqueEpoch(minted.epoch)
    this.store.writeIdentity(minted)
    this.cached = minted
    return minted
  }

  /**
   * Roll the epoch, keeping `feedId`. D1: the feed is the same feed; only its
   * seq-continuity generation changed.
   *
   * The new epoch is checked against the OUTGOING one and refused if equal. That
   * is not paranoia about a good mint — it is the cheapest possible detector for
   * a mint that has been stubbed, frozen or memoised somewhere upstream, and an
   * epoch bump that produces the same epoch is precisely the silent-no-op that
   * leaves every replica applying a foreign timeline with no mismatch to catch.
   */
  bump(cause: EpochBumpCause): FeedIdentity {
    const previous = this.current()
    const epoch = this.mint()
    assertOpaqueEpoch(epoch)
    if (epoch === previous.epoch) {
      throw new FeedIdentityError(
        `bump(${cause}) minted the epoch it was replacing ('${epoch}'). The mint is not producing ` +
          `fresh values, so this bump would be invisible to every replica (ADR 2 D1).`,
      )
    }
    const next: FeedIdentity = { feedId: previous.feedId, epoch }
    this.store.writeIdentity(next)
    this.cached = next
    return next
  }
}
