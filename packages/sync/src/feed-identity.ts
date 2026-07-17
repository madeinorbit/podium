import { randomUUID } from 'node:crypto'

/**
 * Feed identity — the `(feedId, epoch)` half of a replica's cursor triple
 * (ADR 2 D1). Minted and persisted by the authority ALONGSIDE the log, in the
 * same database as `changes`, because that colocation is the whole mechanism:
 * a restore that rolls the log back rolls the epoch back with it, which is
 * precisely what the restore path must then notice and re-mint.
 *
 * ## Why this exists
 *
 * `Ledger.cursor()` is `maxChangeSeq()` — a bare integer. That integer cannot
 * distinguish "you are up to date" from "you hold entities off a timeline that
 * no longer exists". The shipped `cursor > max ⇒ snapshot` heuristic
 * (change-log.ts) catches the easy half of a DB reset and silently corrupts the
 * hard half:
 *
 *   Restore the authority from a pre-migration backup — the SANCTIONED rollback
 *   path, since drizzle has no down migrations. The backup's log ends at seq
 *   400; a client holds cursor 500. Ask now and `500 > 400` → snapshot → healed.
 *   But the authority keeps working. After 100 more commits `max` is 500 again.
 *   The client asks `changesSince(500)`, hits `cursor === max`, and is told
 *   `[]` — "you are up to date". It is not: it holds entities from changes
 *   401..500 of a timeline that no longer exists, AND it missed 401..500 of the
 *   restored one. For every entity never touched again, the phantom is final.
 *   Nothing in the protocol can ever detect this.
 *
 * An epoch costs one opaque id on the wire and one equality check, and closes it.
 *
 * ## Why the epoch is MINTED and not a counter
 *
 * This is the part that looks like fastidiousness and is not. Because the epoch
 * lives in the database, the bump has to happen at restore time, on the RESTORED
 * value. Restore a backup stamped `epoch=3` → bump → `4`. Now restore the same
 * backup AGAIN — a second rollback attempt, a re-run runbook, a botched first
 * restore — and it is `3` again → bump → **`4` again**: a different timeline
 * wearing an epoch clients have already accepted. The counter silently
 * re-collides in exactly the situation the epoch exists to catch.
 *
 * A minted id cannot collide however many times the same backup is restored, in
 * whatever order. Ordering is never needed — a replica only ever asks "is this
 * the generation I hold?", never "is it newer?" — so equality is the entire
 * required operation, and paying for a counter's ordering buys a collision.
 *
 * UUIDv4 rather than ULID: the ADR says "ULID/UUID" and the two are
 * interchangeable for an id compared only by equality (a ULID's sortability is
 * the property we explicitly must not use). `randomUUID` is a node builtin and
 * the repo's standing minting call; a ULID would be a dependency bought for a
 * property this design forbids relying on.
 *
 * [spec:SP-0371] seam note: `feedId` IS the federation seam's authority/feed
 * identity. A future hub distinguishes feeds by it and a node holds one cursor
 * per upstream feed. It is built now precisely because retrofitting identity
 * into already-persisted cursors later is the migration this design spares.
 */

/** The `(feedId, epoch)` pair a replica compares on every exchange. Both are
 *  opaque; both are compared by EQUALITY ONLY. Never order them. */
export interface FeedIdentity {
  /** Stable — minted once per authority database. Changes ONLY when the
   *  database is genuinely a different feed. */
  feedId: string
  /** The current seq-continuity generation. Re-minted whenever the authority
   *  cannot guarantee its seqs continue the ones clients hold. */
  epoch: string
}

/** Narrow structural view over SyncRepository: the feed-identity row. Injected
 *  in the same style as {@link ChangeLogStore} so the Ledger never reaches for a
 *  concrete repository and tests can stub the storage. */
export interface FeedIdentityStore {
  /** The persisted identity, or null before it has ever been minted. */
  readFeedIdentity(): FeedIdentity | null
  /** Persist the identity iff none exists. MUST be a no-op when a row is
   *  already present — minting is once per authority database, and a second
   *  mint would silently re-identify a live feed. */
  initFeedIdentity(identity: FeedIdentity): void
  /** Replace the epoch, keeping `feedId`. The restore path's whole job. */
  setEpoch(epoch: string): void
}

/** Mint a fresh, never-reused generation id. */
export function newEpoch(): string {
  return randomUUID()
}

/** Mint a fresh feed id. */
export function newFeedId(): string {
  return randomUUID()
}

/**
 * The identity of this authority's feed, minting one on first sight. Called
 * once per authority at Ledger construction: an authority that has never run
 * has no identity, and the first boot is the moment it acquires one.
 *
 * Idempotent by construction — `initFeedIdentity` must not overwrite an
 * existing row, so a racing second caller reads the winner's values back rather
 * than re-identifying the feed.
 */
export function ensureFeedIdentity(
  store: FeedIdentityStore,
  mint: () => string = newFeedId,
): FeedIdentity {
  const existing = store.readFeedIdentity()
  if (existing) return existing
  store.initFeedIdentity({ feedId: mint(), epoch: mint() })
  const created = store.readFeedIdentity()
  if (!created) throw new Error('feed identity: initFeedIdentity did not persist a row')
  return created
}

/**
 * Re-mint the epoch: "my seqs no longer continue the ones clients hold."
 *
 * THE caller is the restore path (`restoreDatabase`), which runs this against
 * the restored file BEFORE it is moved into place — so there is no window in
 * which a restored authority is live with an epoch that lies. Any other operator
 * action that rewinds `changes` (a DB rebuild, a manual surgery on the log) owes
 * the same call.
 *
 * `feedId` is deliberately untouched: this is the same feed, on a new
 * generation. Only a genuinely different database is a different feed.
 */
export function remintEpoch(
  store: FeedIdentityStore,
  mint: () => string = newEpoch,
): { feedId: string; previousEpoch: string; epoch: string } {
  const existing = store.readFeedIdentity()
  if (!existing) {
    // No identity to re-mint: a pre-ADR-2 database, or one that never booted.
    // Minting a fresh pair is the correct outcome — every client cursor against
    // it is from an unidentified generation and must re-bootstrap anyway.
    const created = ensureFeedIdentity(store, mint)
    return { feedId: created.feedId, previousEpoch: '', epoch: created.epoch }
  }
  const epoch = mint()
  store.setEpoch(epoch)
  return { feedId: existing.feedId, previousEpoch: existing.epoch, epoch }
}
