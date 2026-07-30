/**
 * ADR 6 D6 — the LEGACY KEY INVENTORY, which the ADR assigns to POD-307:
 * "Exact key inventory is POD-307 implementation work; this ADR requires the
 * upgrade-or-rebootstrap posture."
 *
 * Both adapter issues deliberately skipped it, and POD-374 gave the reason this
 * file is written to honour: "an importer built against a guessed key set is
 * mechanism-present / coverage-absent". So this list is not a guess. It is
 * derived from `packages/client-core/src/replica/replica.ts`, the module that
 * WRITES the keys, and `packages/client-core/src/replica/legacy-keys.test.ts`
 * boots that real writer and asserts the keys it actually produces are exactly
 * these. The proof lives with the writer because `packages/sync` is L2 and may
 * not import client-core; the inventory lives here because the importer does.
 *
 * WHAT IS AND IS NOT REPLICA STORAGE, which is the distinction that makes the
 * inventory useful rather than just long. The old web replica and the mobile
 * AsyncStorage bridge write two very different families under `podium.`:
 *
 *   REPLICA STATE (this file's business). Entity collections, the transcript
 *     window cache, the oplog cursor, the outbox and the awaiting-truth overlay.
 *     ADR 6 D1 forbids all of it from living on localStorage/AsyncStorage at all,
 *     so every key here is retired by the migration — either imported or
 *     discarded, never left behind.
 *
 *   UI PREFERENCES (ADR 6 D7: "Lossy OK"). The view/pane/dock/theme keys, the
 *     `podium.replica.uistate.v1` collection they were folded into, and the
 *     per-file mode families. D1 explicitly ALLOWS these to stay on
 *     localStorage/AsyncStorage. They are listed here so that "the migration left
 *     these behind" is a recorded decision rather than an oversight the next
 *     reader has to re-derive — and so nothing deletes them on the theory that
 *     everything under `podium.replica.` is stale.
 *
 * The mobile bridge (`createAsyncStorageReplicaStorage`) is a synchronous
 * StorageApi over AsyncStorage and stores THE SAME KEY NAMES; the inventory is
 * therefore shared and the platform difference is only which key-value store the
 * caller hands in.
 */

/** The namespace every collection-backed replica key sits under. */
export const LEGACY_REPLICA_PREFIX = 'podium.replica'

/**
 * The entity collections, in the writer's own order
 * (`ENTITY_STORE_KINDS` in replica.ts). `transcripts` is one of them: the old
 * replica kept the bounded transcript window in a collection beside the entity
 * kinds, even though ADR 7 classes it as bulk-plane cache rather than replica
 * state.
 */
export const LEGACY_ENTITY_KINDS = [
  'sessions',
  'issues',
  'conversations',
  'automations',
  'automationRuns',
  'transcripts',
] as const

/** `podium.replica.<kind>.v1` for every entity collection. */
export const LEGACY_ENTITY_KEYS: readonly string[] = LEGACY_ENTITY_KINDS.map(
  (kind) => `${LEGACY_REPLICA_PREFIX}.${kind}.v1`,
)

/** The persisted oplog cursor — a BARE INTEGER, which is why it cannot be
 *  imported (see `readLegacyReplica`). */
export const LEGACY_CURSOR_KEY = `${LEGACY_REPLICA_PREFIX}.cursor.v1`

/** Queued mutations: user intent not yet accepted by the Authority. ADR 6 D4.3
 *  makes losing these a correctness bug rather than degraded UX. */
export const LEGACY_OUTBOX_KEY = `${LEGACY_REPLICA_PREFIX}.outbox.v1`

/** The awaiting-truth stage — entries whose executor resolved but whose covering
 *  server truth has not landed. Deliberately a SEPARATE key in the old design so
 *  a rolled-back build could not replay them as queued. */
export const LEGACY_OUTBOX_AWAITING_KEY = `${LEGACY_REPLICA_PREFIX}.outbox-awaiting.v1`

/** The PRE-replica standalone outbox blob (`OUTBOX_LS_KEY` in
 *  `packages/client-core/src/outbox.ts`). A client that upgraded straight from a
 *  build older than the replica collections still has this and nothing else. */
export const LEGACY_STANDALONE_OUTBOX_KEY = 'podium.outbox.v1'

/** The ui-state COLLECTION blob. Under the replica prefix, but ADR 6 D7 prefs —
 *  see the header. Not imported, and not deleted. */
export const LEGACY_UI_STATE_KEY = `${LEGACY_REPLICA_PREFIX}.uistate.v1`

/**
 * Every key holding REPLICA STATE, which is exactly the set ADR 6 D1 forbids
 * from living on localStorage/AsyncStorage. The migration retires all of them.
 */
export const LEGACY_REPLICA_STATE_KEYS: readonly string[] = [
  ...LEGACY_ENTITY_KEYS,
  LEGACY_CURSOR_KEY,
  LEGACY_OUTBOX_KEY,
  LEGACY_OUTBOX_AWAITING_KEY,
  LEGACY_STANDALONE_OUTBOX_KEY,
]

/**
 * Keys under the replica prefix that are PREFERENCES and stay put (ADR 6 D1's
 * "localStorage for small UI preferences only" is a permission, not a
 * prohibition). Listed so the migration's decision to leave them is explicit.
 */
export const LEGACY_PREFERENCE_KEYS: readonly string[] = [LEGACY_UI_STATE_KEY]

/** True for a key this migration owns. Prefix-matching alone would sweep the
 *  ui-state blob in with the rest, which is the bug this predicate exists to
 *  make impossible. */
export const isLegacyReplicaStateKey = (key: string): boolean =>
  LEGACY_REPLICA_STATE_KEYS.includes(key)
