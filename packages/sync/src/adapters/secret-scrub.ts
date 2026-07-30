/**
 * THE CLIENT SCRUB — server-owned secret material removed from replica storage
 * that ALREADY EXISTS (POD-419, 3.7b).
 *
 * ADR 1 D6's `server-secrets` row is "never replicated, never enqueued". POD-418
 * made the classification derivable and POD-420 made a secret write refusable at
 * the command surface, so nothing NEW can arrive. Neither touched a device that
 * has already been running: an entity row, a cursor blob or an outbox entry
 * written by an earlier build sits on disk until something removes it, and every
 * gate that reasons about the current code reports the store as clean.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT "INCLUDING HISTORICAL" MEANS ON THESE TWO ADAPTERS, MEASURED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Neither client store keeps superseded VERSIONS of a row: `entities` is keyed
 * `(principal, entity, entityId)` and `meta` is keyed `(principal, key)`, so an
 * update overwrites. The history that does exist is in the OUTBOX, which retains
 * terminal entries — `applied`, `rejected`, `expired` and dead-lettered rows
 * whose `input` is kept verbatim precisely so a user can recover their intent
 * (ADR 6 D4.3 / D9). Those are the rows a scrub written against "the live queue"
 * would walk straight past, so this pass takes EVERY row of EVERY region in
 * whatever state, and `secret-scrub.test.ts` seeds a dead-lettered entry, an
 * applied terminal entry and a live one with DISTINCT material to prove it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT RUNS ON EVERY OPEN, AND IS NOT GATED ON A SCHEMA VERSION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The obvious shape is a version-gated one-shot arm: bump the adapter schema,
 * scrub in the upgrade path, never again. It was rejected, and the reason is the
 * failure mode rather than the cost:
 *
 *   - A store ALREADY at the new version never runs the arm again. If material
 *     arrives after the upgrade — a build with a regression, a store restored
 *     from a backup taken before it, a device that upgraded through a broken
 *     intermediate — the one-shot has already fired and nothing will ever remove
 *     it. A secret at rest is not a schema shape; it can come back.
 *   - The two adapters version themselves differently (IndexedDB's database
 *     version versus a `schema_version` row), so a version-gated scrub is two
 *     mechanisms with two chances to be wrong about the same property.
 *
 * Running it every open makes the property CONTINUOUS rather than historical:
 * after any open, the store holds no classified secret material. The cost is a
 * walk over rows the adapter has just hydrated anyway, and a write only when
 * something was actually found — {@link planSecretScrub} returns the SAME row
 * reference when a value is clean, so a converged store issues no transaction.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT LIVES HERE, SO NO CLIENT HAS TO REACH FOR IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The derivation is `@podium/model`'s (pure, zod-only) and the application is the
 * adapter's own open path. `apps/web` and `apps/mobile` construct nothing new and
 * import nothing new — which matters because whether a client may import
 * `@podium/sync` at all is POD-307's live decision, and this issue must not
 * depend on which way it goes.
 */

import { scrubSecretMaterial } from '@podium/model'

/** What a scrub pass did. Returned rather than logged, because a caller — and a
 *  test — must be able to tell "found nothing" from "did not look". */
export interface SecretScrubReport {
  /** Rows examined, across every region. */
  readonly scanned: number
  /** Rows whose stored value changed and must be written back. */
  readonly rewritten: number
  /**
   * Every address material was found at, region-qualified (e.g.
   * `outbox[mut_7].input.apiKeys.openai`).
   *
   * THE INSTRUMENT'S OWN NON-VACUITY CHECK. A scrub that finds nothing is
   * indistinguishable from a broken one from the outside, and both leave the
   * caller's assertions passing (POD-363). Every test here asserts on this list,
   * never on "it did not throw".
   */
  readonly removed: readonly string[]
}

export const EMPTY_SCRUB_REPORT: SecretScrubReport = { scanned: 0, rewritten: 0, removed: [] }

/** One row a scrub can rewrite: an opaque handle plus the stored value. */
export interface ScrubCandidate<T> {
  /** Region-qualified address used in {@link SecretScrubReport.removed} — e.g.
   *  `outbox[mut_7]`. Purely diagnostic; nothing keys off it. */
  readonly address: string
  readonly row: T
  /** The stored value to inspect. For an entity that is its cached wire object;
   *  for an outbox entry the whole record, because material can sit in `input`
   *  OR in a field a later version adds. */
  readonly value: unknown
}

export interface ScrubRewrite<T> {
  readonly row: T
  /** The value with every classified secret member removed. */
  readonly value: unknown
}

/**
 * Plan a scrub over a set of rows. PURE — it reads and decides, and the caller
 * writes inside whatever transaction its engine requires.
 *
 * Splitting plan from apply is what lets both adapters share the decision while
 * keeping their own durability story: IndexedDB must issue its writes inside one
 * native transaction that no `await` may cross, and the mobile adapter commits
 * through its own SQLite transaction. A shared function that did both would have
 * to pick one, and the other would get a scrub outside its transaction — durable
 * on a happy path and silently lost on a crash, which for a scrub means the
 * material comes back.
 */
export function planSecretScrub<T>(candidates: Iterable<ScrubCandidate<T>>): {
  readonly rewrites: readonly ScrubRewrite<T>[]
  readonly report: SecretScrubReport
} {
  const rewrites: ScrubRewrite<T>[] = []
  const removed: string[] = []
  let scanned = 0

  for (const candidate of candidates) {
    scanned += 1
    const result = scrubSecretMaterial(candidate.value)
    if (result.removed.length === 0) continue
    rewrites.push({ row: candidate.row, value: result.value })
    for (const address of result.removed) removed.push(`${candidate.address}.${address}`)
  }

  return { rewrites, report: { scanned, rewritten: rewrites.length, removed } }
}

/** Merge the reports of several regions into one. */
export function mergeScrubReports(...reports: readonly SecretScrubReport[]): SecretScrubReport {
  return {
    scanned: reports.reduce((n, r) => n + r.scanned, 0),
    rewritten: reports.reduce((n, r) => n + r.rewritten, 0),
    removed: reports.flatMap((r) => [...r.removed]),
  }
}
