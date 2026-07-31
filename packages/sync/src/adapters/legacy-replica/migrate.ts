/**
 * ADR 6 D6, END TO END: read the legacy store, decide whether its work may be
 * adopted, commit the result in ONE transaction, and only then retire the old keys.
 *
 * `./import` decides what is DECODABLE and `./adoption` decides what is
 * ATTRIBUTABLE; both are pure and neither writes anything. This module is the only
 * one that commits, and it exists so the ORDER of the three steps is a property of
 * one function rather than of every caller's discipline — D6 clause 3 ("delete
 * legacy keys only after a successful durable commit") is a rule about sequencing,
 * and a rule about sequencing spread across two composition roots is a rule that
 * will be broken by exactly one of them.
 *
 * WHY THERE IS NO HALF-MIGRATED STORE TO DETECT, which is the strongest form of
 * D6 clause 4 ("never leave a client stuck with a half-migrated cursor") and of
 * D4.7's mobile lifecycle rules. Every record this migration produces lands in a
 * SINGLE span, so the durable store moves from "nothing" to "all of it" with no
 * observable state in between — on SQLite that is one `BEGIN IMMEDIATE … COMMIT`,
 * which either happened or did not. A kill therefore cannot produce a partially
 * migrated store; it can only produce one of two states, and both are safe:
 *
 *   KILLED BEFORE THE COMMIT — nothing was written, every legacy key is still
 *     there, and the next open runs the whole migration again from intact input.
 *
 *   KILLED AFTER THE COMMIT, BEFORE (OR DURING) KEY RETIREMENT — the new store is
 *     complete and some legacy keys survive, so the next open imports the same
 *     entries a second time. That is IDEMPOTENT rather than duplicative: outbox
 *     rows are keyed by `mutationId`, a client-minted idempotency key (ADR 2 D8),
 *     and `apply`'s `put` "inserts or replaces by mutationId". Re-running writes
 *     the same rows to the same keys.
 *
 * And if the SQLite FILE itself is torn — the third thing a kill can damage — the
 * adapter's own open path clears it and cold-starts (D4.5), which lands us back in
 * the first state above with the legacy keys still intact. The store is discarded,
 * never adopted half-way. That is the whole argument, and `migrate.test.ts` drives
 * each of the three kills rather than asserting the reasoning.
 *
 * THE ONE RESIDUAL WINDOW, named rather than hidden: an entry adopted, DRAINED, and
 * then re-imported because the kill landed between the commit and the key deletion
 * would be re-sent. It is absorbed where the system already absorbs it — the
 * Authority dedupes on `mutationId` (D11) — and the alternative (a durable
 * migration marker) buys only this one case at the cost of a schema the adapter
 * does not otherwise need. Stated here so the next reader inherits the trade rather
 * than rediscovering the window and assuming it was missed.
 *
 * WHY KEY RETIREMENT IS BEST-EFFORT AND NEVER THROWS. A `removeItem` that fails
 * after a successful commit must not turn a completed migration into a failed boot:
 * the keys are then stale rather than dangerous, the next open re-imports
 * idempotently, and D4.5's "never wedge boot" governs here exactly as it governs
 * an unreadable store.
 */

import type { OutboxStorePort, OutboxRecordExpectation } from '../../outbox/ports'
import type { OutboxAttribution, OutboxCommand } from '../../outbox/records'
import type { SyncSpan } from '../../replica/ports'
import {
  decideLegacyAdoption,
  type LegacyAdoptionReason,
  type LegacyIdentityEvidence,
} from './adoption'
import { type LegacyImportRejection, type LegacyKeyValueSource, readLegacyReplica } from './import'

/**
 * The legacy store, with the one extra verb this module needs beyond reading.
 * Both platforms have it: `localStorage.removeItem` on web, and the mobile
 * bridge's `StorageApi` over AsyncStorage. Nothing here names either.
 */
export interface LegacyKeyValueStore extends LegacyKeyValueSource {
  removeItem(key: string): void
}

export interface LegacyMigrationHost {
  readonly legacy: LegacyKeyValueStore
  readonly outbox: OutboxStorePort
  /**
   * Open the transaction everything commits in, and settle it.
   *
   * Injected rather than derived from a store handle because this module must not
   * know which adapter it is running over — the mobile SQLite view and the web
   * IndexedDB one both supply a span, and their commit semantics differ in ways
   * neither the importer nor the gate should be able to observe.
   */
  readonly transact: <T>(run: (span: SyncSpan) => Promise<T>) => Promise<T>
  /** Resolves a legacy `kind` to the contract it was authored under — see
   *  `readLegacyReplica`'s header on why this cannot be guessed here. */
  readonly resolveCommand: (kind: string) => OutboxCommand | undefined
  /** Who adopted entries are attributed to. Only consulted on the adopt arm. */
  readonly attribution: OutboxAttribution
  readonly evidence: LegacyIdentityEvidence
  readonly now: () => number
}

/**
 * What happened, in enough detail for a client to TELL THE USER. Every field here
 * exists because something in it must reach a human: work that was carried across,
 * work that was parked, and a replica that is about to re-bootstrap are all things
 * a person notices, and ADR 6 D4.4's posture on degradation ("explicitly informed",
 * never silent) is the same posture this migration owes them.
 */
export interface LegacyMigrationOutcome {
  readonly ran: boolean
  /** Absent when `ran` is false — there was nothing to decide. */
  readonly reason?: LegacyAdoptionReason
  /** Entries carried across as drainable work. */
  readonly adopted: number
  /** Entries parked as dead letters with their payload dropped (see `./adoption`). */
  readonly parked: number
  /** Entries that never got as far as the gate: undecodable, or naming a command
   *  no contract resolves. Reported, never swallowed. */
  readonly rejected: readonly LegacyImportRejection[]
  /** True when a legacy cursor was dropped, so the client re-bootstraps once. */
  readonly cursorDiscarded: boolean
  /** Legacy keys still present after retirement — a `removeItem` that failed.
   *  Harmless (the next open re-imports idempotently) and reported anyway, because
   *  a silently half-retired keyspace is the kind of thing that looks like a bug
   *  for months. */
  readonly keysLeftBehind: readonly string[]
}

const NOTHING_TO_DO: LegacyMigrationOutcome = {
  ran: false,
  adopted: 0,
  parked: 0,
  rejected: [],
  cursorDiscarded: false,
  keysLeftBehind: [],
}

/**
 * Run the migration. Resolves; never rejects.
 *
 * A migration that threw would take the app down on launch over a store the user
 * could have simply cold-started without — the failure mode D4.5 rules out for the
 * adapter, applied to the path that runs immediately before it.
 */
export async function migrateLegacyReplica(
  host: LegacyMigrationHost,
): Promise<LegacyMigrationOutcome> {
  const plan = readLegacyReplica(host.legacy, {
    resolveCommand: host.resolveCommand,
    attribution: host.attribution,
  })
  if (plan.verdict === 'nothing-to-do') return NOTHING_TO_DO

  const decision = decideLegacyAdoption(plan, host.evidence, host.now())

  if (decision.records.length > 0) {
    // `expect: 'absent'` on every key, which is the uniqueness check the port
    // documents — and on a re-run after a killed retirement it is the right
    // answer too: a conflict means the rows are ALREADY THERE, which is the
    // idempotent outcome this migration wants, not a failure to report.
    const expect: OutboxRecordExpectation[] = decision.records.map((r) => ({
      mutationId: r.mutationId,
      expect: 'absent' as const,
    }))
    try {
      await host.transact((span) => host.outbox.apply({ put: decision.records, expect }, span))
    } catch {
      // The commit did not happen. Leave every legacy key in place: the next open
      // reads the same intact input and tries again. Retiring them here would be
      // the exact data loss D6 clause 3 orders the sequencing to prevent.
      return {
        ran: false,
        reason: decision.reason,
        adopted: 0,
        parked: 0,
        rejected: plan.rejected,
        cursorDiscarded: false,
        keysLeftBehind: [...plan.retireKeys],
      }
    }
  }

  return {
    ran: true,
    reason: decision.reason,
    adopted: decision.adopt ? decision.records.length : 0,
    parked: decision.adopt ? 0 : decision.records.length,
    rejected: plan.rejected,
    cursorDiscarded: plan.cursorDiscarded,
    keysLeftBehind: retire(host.legacy, plan.retireKeys),
  }
}

/** Best-effort, per key, never throwing — see the header. */
function retire(legacy: LegacyKeyValueStore, keys: readonly string[]): readonly string[] {
  const leftBehind: string[] = []
  for (const key of keys) {
    try {
      legacy.removeItem(key)
    } catch {
      leftBehind.push(key)
    }
  }
  return leftBehind
}
