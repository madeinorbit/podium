/**
 * ADR 6 D6 — reading the legacy localStorage / AsyncStorage replica so a client
 * on the new transactional store either UPGRADES or cleanly RE-BOOTSTRAPS, and
 * never sticks half-way.
 *
 * D6's four clauses, and what each one turned out to mean once the legacy shapes
 * were read rather than assumed:
 *
 *   1. "Detect legacy keys." — `./keys`, measured against the writer.
 *   2. "Best-effort import when the payload is complete and decodable;
 *      otherwise discard and cold bootstrap."
 *   3. "Delete legacy keys only after a successful durable commit of the new
 *      store." — hence this module RETURNS a plan and never deletes anything.
 *   4. "Never leave a client stuck with a half-migrated cursor."
 *
 * WHAT IS IMPORTED, AND WHAT IS DELIBERATELY DISCARDED. This is the substance of
 * clause 2 and every part of it is a decision with a source, because "best
 * effort" read as "carry everything across" would fabricate three fields the
 * legacy store does not contain.
 *
 *   OUTBOX — IMPORTED. ADR 6 D4.3: entries representing user intent not yet
 *     accepted by the Authority "are durable on the same footing as entity rows.
 *     Losing them on crash is a correctness bug, not degraded UX." It is the one
 *     family the user would notice, and the only one that cannot be re-fetched.
 *
 *   CURSOR — ALWAYS DISCARDED, and this is not laziness. The legacy cursor is a
 *     bare integer. The kernel's is `{ feedId, epoch, seq }`, and ADR 2 D1 is
 *     explicit that "a cursor is meaningless without feed identity. Never a bare
 *     integer" — the epoch exists precisely because a counter re-collides across
 *     restores. There is no honest way to synthesise the two missing halves, and
 *     a fabricated epoch is worse than no cursor: it makes a stale replica look
 *     current. Discarding costs one bootstrap and is D4.2's SAFE direction
 *     (cursor behind data is recovered by re-pull; cursor ahead of data is the
 *     forbidden state). This is also how clause 4 is satisfied structurally
 *     rather than by care: there is no cursor to half-migrate.
 *
 *   ENTITIES AND TRANSCRIPT WINDOWS — DISCARDED, for the same reason one layer
 *     down. `EntityRecord.provenance.seq` is required and is not recoverable
 *     from a legacy row, and with no cursor to import the bootstrap re-fetches
 *     them on the first connection anyway. ADR 6 D7 and the replica's own header
 *     both call this data a cache. So the trade is: one cold paint, against
 *     writing a made-up feed position into a field the Replica stores and echoes.
 *
 *   UI PREFERENCES — LEFT ALONE. ADR 6 D1 permits localStorage for prefs and D7
 *     classes them as lossy. See `./keys`.
 *
 * TWO THINGS THE CALLER MUST SUPPLY, because this module refuses to invent them:
 *
 *   `resolveCommand` — a legacy entry carries a bare `kind` string and NO
 *     contract version. `OutboxCommand` requires `{ name, version, delivery }`,
 *     and D9 stores the version so "a replay is judged against the version the
 *     user authored under". Guessing `version: 1` would silently re-author every
 *     queued mutation under a version its input may not satisfy. So the caller —
 *     the composition root, which holds the contract table — resolves it, and an
 *     entry that resolves to nothing is REPORTED as undeliverable rather than
 *     dropped in silence or replayed under a guess.
 *
 *   `attribution` — the legacy entry carries no identity at all, and ADR 3 D17
 *     requires both halves of the pair to come from the authenticated transport.
 *     The caller passes the session's authenticated principal.
 *
 * ONE PARTITION FOR THE WHOLE IMPORT. ADR 3 D12 makes `partitionKey` FIFO within
 * a key and concurrent across keys, and the contract's target extractor computes
 * it — from data a legacy entry does not carry. Splitting by `mutationId` would
 * give every entry its own partition and lose the ordering between two edits of
 * the same row, which is precisely what the legacy `chained` flag existed to
 * track. So every imported entry lands in ONE partition: strictly FIFO, more
 * serialised than necessary, and correct. Over-serialising a one-time drain of a
 * handful of entries costs nothing; under-serialising corrupts a rename.
 */

import type { MutationId } from '@podium/protocol'
import type { OutboxAttribution, OutboxCommand, OutboxRecord } from '../../outbox/records'
import {
  isLegacyReplicaStateKey,
  LEGACY_OUTBOX_AWAITING_KEY,
  LEGACY_OUTBOX_KEY,
  LEGACY_REPLICA_STATE_KEYS,
  LEGACY_STANDALONE_OUTBOX_KEY,
} from './keys'

/**
 * The legacy store, as a synchronous key-value seam. Both platforms already have
 * one: `window.localStorage` on web, and the mobile bridge's hydrated
 * `StorageApi` over AsyncStorage. Nothing here names either.
 */
export interface LegacyKeyValueSource {
  getItem(key: string): string | null
}

/** The partition every imported entry shares — see the header. */
export const LEGACY_IMPORT_PARTITION = 'legacy-import'

/** Why an entry could not be carried across. Reported, never swallowed. */
export interface LegacyImportRejection {
  readonly key: string
  readonly mutationId?: string
  readonly reason: 'unreadable-blob' | 'malformed-entry' | 'unknown-command'
  readonly detail: string
}

export interface LegacyReplicaImportPlan {
  /**
   * `import` — there is something to carry across.
   * `nothing-to-do` — no legacy replica state is present at all (a fresh client).
   * `discard` — legacy state is present but nothing survived decoding; the client
   *   cold-bootstraps. Never a wedge: both non-import verdicts still retire keys.
   */
  readonly verdict: 'import' | 'nothing-to-do' | 'discard'
  /** Outbox entries to enqueue, in FIFO order, inside the new store's ONE commit. */
  readonly outbox: readonly OutboxRecord[]
  /**
   * Legacy keys to delete — but only AFTER that commit succeeds (D6 clause 3).
   * Returning them instead of deleting them is what keeps this module honest
   * about the ordering: it cannot delete early because it cannot delete at all.
   */
  readonly retireKeys: readonly string[]
  /** Everything that did not survive, with the reason. */
  readonly rejected: readonly LegacyImportRejection[]
  /** True when a legacy cursor was present and dropped — see the header. The
   *  caller surfaces this as "re-bootstrapping", which is a visible, explained
   *  degradation rather than a silent one. */
  readonly cursorDiscarded: boolean
}

export interface LegacyReplicaImportOptions {
  /** Resolves a legacy `kind` to the contract it was authored against. */
  readonly resolveCommand: (kind: string) => OutboxCommand | undefined
  /** The authenticated principal the imported entries are re-attributed to. */
  readonly attribution: OutboxAttribution
}

/** One legacy queued mutation, as `packages/client-core/src/outbox.ts` writes it. */
interface LegacyOutboxEntry {
  mutationId: string
  kind: string
  input: unknown
  queuedAt: number
  state?: 'awaiting-truth'
  resolvedAt?: number
}

/**
 * TanStack DB's `localStorageCollectionOptions` blob:
 * `{ [encodedKey]: { versionKey, data } }`. Returns the `data` values, or
 * `undefined` when the blob is unreadable — which the caller treats as
 * "discard", never as "empty" (D4.5's posture: clear and cold-start, never
 * wedge). The pre-replica standalone key is a plain JSON ARRAY instead, so both
 * shapes are accepted.
 */
function decodeCollectionBlob(raw: string | null): unknown[] | undefined {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    if (!parsed || typeof parsed !== 'object') return undefined
    const rows: unknown[] = []
    for (const value of Object.values(parsed)) {
      if (value && typeof value === 'object' && 'data' in value) {
        rows.push((value as { data: unknown }).data)
      }
    }
    return rows
  } catch {
    return undefined
  }
}

function isLegacyEntry(row: unknown): row is LegacyOutboxEntry {
  if (!row || typeof row !== 'object') return false
  const e = row as LegacyOutboxEntry
  return (
    typeof e.mutationId === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.queuedAt === 'number'
  )
}

/**
 * Read the legacy replica and produce the plan. Pure: reads, decides, and
 * returns. It writes nothing and deletes nothing — clause 3's ordering is a
 * property of this signature rather than of the caller's discipline.
 */
export function readLegacyReplica(
  source: LegacyKeyValueSource,
  options: LegacyReplicaImportOptions,
): LegacyReplicaImportPlan {
  const rejected: LegacyImportRejection[] = []
  const outbox: OutboxRecord[] = []
  const retireKeys: string[] = []
  let sawAnything = false

  for (const key of LEGACY_REPLICA_STATE_KEYS) {
    const raw = safeGet(source, key)
    if (raw === null) continue
    sawAnything = true
    retireKeys.push(key)
  }

  // FIFO across the three outbox homes, in the order a drain would have seen
  // them: the pre-replica blob is the oldest intent in the store, and the
  // awaiting-truth stage is by construction later than anything still queued.
  for (const key of [
    LEGACY_STANDALONE_OUTBOX_KEY,
    LEGACY_OUTBOX_KEY,
    LEGACY_OUTBOX_AWAITING_KEY,
  ]) {
    const raw = safeGet(source, key)
    if (raw === null) continue
    const rows = decodeCollectionBlob(raw)
    if (rows === undefined) {
      rejected.push({
        key,
        reason: 'unreadable-blob',
        detail: 'not decodable as a collection blob or a JSON array — discarded, not retried',
      })
      continue
    }
    for (const row of rows) {
      if (!isLegacyEntry(row)) {
        rejected.push({ key, reason: 'malformed-entry', detail: 'missing mutationId/kind/queuedAt' })
        continue
      }
      const command = options.resolveCommand(row.kind)
      if (command === undefined) {
        rejected.push({
          key,
          mutationId: row.mutationId,
          reason: 'unknown-command',
          detail: `no contract resolves '${row.kind}' — replaying it under a guessed version could re-author the write`,
        })
        continue
      }
      outbox.push({
        mutationId: row.mutationId as MutationId,
        command,
        input: row.input,
        partitionKey: LEGACY_IMPORT_PARTITION,
        attribution: options.attribution,
        // The legacy awaiting-truth stage means "the executor resolved, we are
        // holding the overlay until covering truth lands" — D9's `accepted`,
        // which is exactly "the Authority took it, it has not been applied to my
        // view yet". Mapping it to `queued` would re-send an accepted mutation.
        state: row.state === 'awaiting-truth' ? 'accepted' : 'queued',
        queuedAt: row.queuedAt,
        attempts: 0,
      })
    }
  }

  // Sort by the authored time rather than trusting per-key ordering: the three
  // homes were written independently, and FIFO is by intent age.
  outbox.sort((a, b) => a.queuedAt - b.queuedAt)

  const verdict: LegacyReplicaImportPlan['verdict'] =
    outbox.length > 0 ? 'import' : sawAnything ? 'discard' : 'nothing-to-do'

  return {
    verdict,
    outbox,
    retireKeys,
    rejected,
    cursorDiscarded: retireKeys.some((k) => k.endsWith('.cursor.v1')),
  }
}

/** A key-value store may throw (private mode, a revoked origin). An unreadable
 *  legacy store is a cold start, never a boot failure (D4.5). */
function safeGet(source: LegacyKeyValueSource, key: string): string | null {
  try {
    return source.getItem(key)
  } catch {
    return null
  }
}

export { isLegacyReplicaStateKey }
