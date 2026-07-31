/**
 * WHAT A REFUSAL DOES TO THE BROWSER'S LEGACY STORE (POD-1252).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A HELPER AND THE GATE CALL IS NOT
 * ---------------------------------------------------------------------------
 *
 * `decideLegacyAdoption` stays AT each composition root — `webReplica.ts` and
 * `desktopReplica.ts` each call it themselves — because the question a reader
 * arrives with ("does this client attribute its store before adopting it?") is
 * asked OF the file that composes the store, and a helper moves that answer one
 * hop from where it is looked for (POD-1220, quoted in `scripts/audit-phase2-client.ts`).
 *
 * What lives here is the OTHER half: what a refusal must DO to a localStorage
 * legacy replica. That half is identical on both roots — the desktop root reads
 * the very same `window.localStorage` blobs, because SQLite mode's one-time
 * localStorage→SQLite migration reads them (see `legacyMigrationStorage` in
 * `packages/client-core/src/replica/replica.ts`) — and two hand-written copies of
 * a privacy rule is the failure mode `adoption.ts` names in its own header.
 *
 * ---------------------------------------------------------------------------
 * THE THREE FAMILIES, AND WHY EACH IS TREATED DIFFERENTLY
 * ---------------------------------------------------------------------------
 *
 * ENTITY ROWS AND THE CURSOR — DELETED. They are a cache: re-derivable at will,
 * so discarding costs one bootstrap, while adopting rows that may be someone
 * else's costs the property the whole privacy model rests on (POD-307). This is
 * the family the counterfactual in the tests measures, because it is the only one
 * whose absence is observable through the replica's own read seam.
 *
 * UI PREFERENCES — LEFT ALONE. ADR 6 D1 explicitly allows the view/pane/dock/theme
 * keys to live on localStorage, and `LEGACY_PREFERENCE_KEYS` records the decision
 * to leave them. They are named here (rather than merely not-mentioned) so that
 * "the discard did not delete the user's layout" is a measured claim: the deletion
 * set is `LEGACY_ENTITY_KEYS` + `LEGACY_CURSOR_KEY` read from `keys.ts`, never a
 * prefix sweep of `podium.replica.`, which would take the ui-state blob with it.
 *
 * QUEUED WORK — PARKED, NEITHER ADOPTED NOR DESTROYED. ADR 6 D4.3 makes losing
 * outbox entries "a correctness bug, not degraded UX", so a discard may not simply
 * delete them; and adopting them is the sharpest form of the harm, because a
 * queued write replayed under the new principal's name is re-authorized against
 * THEIR rights at drain (ADR 3 D8) and no check downstream can catch it. So the
 * entries move to the dead-letter home: never drained, surfaced through POD-316's
 * recovery UI, and REDACTED.
 *
 * THE REDACTION IS THE ONE PLACE THIS DELIBERATELY BREAKS A STATED CONTRACT, and
 * it is `adoption.ts`'s break rather than a new one: `DeadLetterRecord.input` is
 * documented as "the author's own input, verbatim", which is true precisely
 * because everywhere else the author and the reader are the same person. Here they
 * provably are not — the refusal arm fires exactly when that could not be
 * established — so carrying the text across would show one person's unsent message
 * to another in their recovery UI, turning a discard into a disclosure.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARK IS EXPRESSED HERE RATHER THAN TAKEN FROM `decideLegacyAdoption`
 * ---------------------------------------------------------------------------
 *
 * The gate returns the parked records itself — but as `OutboxRecord`s, the KERNEL
 * store's vocabulary, and this store is the legacy replica, whose durable entries
 * are `OutboxEntry`s. There is no honest way to hand `decideLegacyAdoption` a plan
 * of entries it cannot type, so the park is written in the local vocabulary. What
 * is NOT restated is the rule: the reason code is imported (`UNATTRIBUTABLE_REASON`)
 * rather than respelled `{ code: 'unauthorized' }`, so a change to the closed set
 * in `../../outbox/reasons` reaches this park instead of silently diverging from it.
 */

import type { OutboxEntry } from '@podium/client-core/outbox'
import type { Replica, StorageApi } from '@podium/client-core/replica'
import {
  LEGACY_CURSOR_KEY,
  LEGACY_ENTITY_KEYS,
  type LegacyIdentityEvidence,
  UNATTRIBUTABLE_REASON,
} from '@podium/sync/adapters/legacy-replica'

/**
 * The principal a browser can name today.
 *
 * `CLIENT_PRINCIPAL_GRADE` is still `device` — one shared password, and
 * `client_sessions` has no user column — so there is exactly one principal and it
 * is this constant. Kept identical to `KERNEL_REPLICA_PRINCIPAL` on purpose: the
 * two roots describe the same person on the same device, and a second spelling
 * would make a store written by one unreadable to the other for a reason nobody
 * intended.
 */
export const WEB_REPLICA_PRINCIPAL = 'default'

/**
 * The evidence this tree can honestly supply, and why it is a DEFAULT rather than
 * a hardcode.
 *
 * `single-account` is the arm's definition verbatim: no user identities exist in
 * the system at all, so a pre-identity store can only be the one operator's.
 * Injectable because the day per-user login lands the default stops being true and
 * a hardcoded arm would keep silently adopting — and because a test can present
 * `unknown` or a foreign ledger and observe the REFUSAL, which is the only way to
 * know the gate can say no.
 */
export function defaultWebEvidence(
  principal: string = WEB_REPLICA_PRINCIPAL,
): LegacyIdentityEvidence {
  return { kind: 'single-account', principal }
}

/**
 * The EMPTY plan the decision is taken over.
 *
 * `decideLegacyAdoption` returns two things — a decision and a set of records —
 * and only the decision applies at a root that is not migrating anything into the
 * kernel store. Re-deriving the rule locally would fork it, and a second copy of a
 * privacy rule is worse than an off-label call to the first. (`kernelReplica.ts`
 * makes the same call for the same reason.)
 */
export const NO_IMPORT_PLAN = {
  verdict: 'import',
  outbox: [],
  retireKeys: [],
  rejected: [],
  cursorDiscarded: false,
} as const

/**
 * Delete the cached rows and the cursor. Call BEFORE constructing the replica.
 *
 * Ordering is load-bearing and is the reason this is not a method on the replica:
 * the legacy replica loads its collections from storage as it is built, so a
 * discard that ran afterwards would be a discard of rows the engine could already
 * have been handed. Deleting the keys first means the construction that follows
 * reads a cold store — the same posture `kernelReplica.ts` gets from calling
 * `discardCache()` before the first read.
 *
 * Best-effort per key: a `removeItem` that throws (quota-locked storage, a
 * cross-origin frame) must not wedge boot — D4.5 — and the keys it could not
 * remove are the ones the NEXT boot discards again, because the decision is taken
 * on every open rather than recorded as done.
 */
export function discardUnattributedEntityRows(storage: StorageApi): void {
  for (const key of [...LEGACY_ENTITY_KEYS, LEGACY_CURSOR_KEY]) {
    try {
      storage.removeItem(key)
    } catch {
      // see above: a failed removal is stale data, not a broken boot
    }
  }
}

/**
 * Move every queued and awaiting-truth entry into the dead-letter home, redacted.
 *
 * Call AFTER constructing the replica: the three outbox homes are read through the
 * replica's own seams so this shares one decoder with the writer, rather than
 * re-parsing the collection blob format — the fixture-verified-against-nothing
 * shape `legacy-snapshot.ts` exists to prevent.
 *
 * Returns how many entries lost their payload, which the caller surfaces. A
 * migration that parked work silently is the thing D4.3 forbids.
 */
export function parkUnattributedOutbox(replica: Replica, now: number): number {
  const queued = replica.outboxStorage()
  const awaiting = replica.outboxAwaitingStorage()
  const parked = replica.outboxDeadLetterStorage()
  // Read all three BEFORE writing any: `save()` has snapshot semantics, and
  // clearing a home first would leave nothing to carry across if the park threw
  // between the two calls.
  const carried = [...queued.load(), ...awaiting.load()].map((entry) => redact(entry, now))
  if (carried.length === 0) return 0
  parked.save([...parked.load(), ...carried])
  queued.save([])
  awaiting.save([])
  return carried.length
}

/**
 * A store the one-time legacy→SQLite migration can read NOTHING out of.
 *
 * The desktop root's refusal is shaped differently from the browser's, and the
 * difference is which role the localStorage blobs play. On the browser they ARE
 * the live store, so a refusal must discard them. On the desktop they are only a
 * MIGRATION SOURCE — the live store is the SQLite file — so the right refusal is
 * the one `side-cache.ts` already takes toward an unattributable queue: "LEFT
 * WHERE IT IS, not adopted and not destroyed", so a later boot that CAN attribute
 * the device still takes the work. Declining to adopt is not the same as
 * discarding.
 *
 * Handing this in as `ReplicaInit.storage` is what enforces that: a non-undefined
 * `storage` switches off `legacyMigrationStorage`'s ambient reach for
 * `window.localStorage` entirely, so the migration reads an empty store instead of
 * someone else's blobs — and, reading nothing, retires nothing.
 *
 * Map-backed rather than a null-returning stub so the replica's storage probe
 * succeeds and the collections take their normal path; the point is that it is
 * EMPTY and private, not that it is broken.
 */
export function noLegacyMigrationSource(): StorageApi {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

/**
 * One entry parked: envelope kept, payload dropped, not drainable.
 *
 * `state: 'dead-letter'` is what makes it non-drainable — the Outbox never
 * attempts a dead-lettered record — and `input: null` is the redaction. The
 * mutation id survives so a re-issue can be told apart from the original (D11.4),
 * and `attempts: 0` is the truth: it was never sent.
 */
function redact(entry: OutboxEntry, now: number): OutboxEntry {
  return {
    ...entry,
    input: null,
    state: 'dead-letter',
    resolvedAt: undefined,
    deadLetter: {
      reason: UNATTRIBUTABLE_REASON,
      parkedFrom: 'rejected',
      deadLetteredAt: now,
      attempts: 0,
    },
  }
}
