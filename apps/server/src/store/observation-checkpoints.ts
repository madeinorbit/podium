// workspace-scoped (POD-6959)
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { ObservationProvider, SessionObservationCheckpointV1 } from '@podium/protocol'
import { and, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm'
import type { sessionObservationCheckpoints } from '../migrations/schema'
import { captureWrite } from '../sync/capture-pg'
import { dialectOf } from './executor/dialect-prepared'
import type {
  StoreDrizzle,
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  sameWorkspace,
  WORKSPACE,
} from './executor/sync-drizzle'
import type {
  ObservationLeaseRecord,
  TerminalCandidateFacts,
  TerminalCandidateRecord,
} from './types'

const log = createLogger('server:store')

function sameFacts(a: TerminalCandidateFacts, b: TerminalCandidateFacts): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameFactsAcrossReattachment(
  previous: TerminalCandidateFacts,
  next: TerminalCandidateFacts,
): boolean {
  const {
    observerGeneration: previousGeneration,
    lastOutputAtMs: previousOutputAt,
    outputCount: previousOutputCount,
    ...previousStable
  } = previous
  const {
    observerGeneration: nextGeneration,
    lastOutputAtMs: nextOutputAt,
    outputCount: nextOutputCount,
    ...nextStable
  } = next
  return (
    nextGeneration > previousGeneration &&
    nextOutputAt >= previousOutputAt &&
    nextOutputCount >= previousOutputCount &&
    JSON.stringify(previousStable) === JSON.stringify(nextStable)
  )
}

/** The checkpoint fields a durable session record reads (POD-7575). */
export type CheckpointRecordFacts = Pick<
  SessionObservationCheckpointV1,
  'turnState' | 'providerAt' | 'providerSessionId'
>
const CheckpointRecordFacts = SessionObservationCheckpointV1.pick({
  schemaVersion: true,
  turnState: true,
  providerAt: true,
  providerSessionId: true,
})

export type ObservationRebindResult =
  | {
      kind: 'accepted'
      disposition: 'advanced' | 'unchanged' | 'duplicate'
      lease: ObservationLeaseRecord
    }
  | {
      kind: 'rejected'
      rejectionReason: 'stale_observer_generation' | 'provider_binding_mismatch'
      lease: ObservationLeaseRecord
    }

/** The columns every lease read projects — the same list, spelled once. */
const LEASE_COLUMNS = (t: StoreTables) => ({
  sessionId: t.sessionObservationCheckpoints.sessionId,
  provider: t.sessionObservationCheckpoints.provider,
  providerSessionId: t.sessionObservationCheckpoints.providerSessionId,
  bindingVersion: t.sessionObservationCheckpoints.bindingVersion,
  observationGeneration: t.sessionObservationCheckpoints.observationGeneration,
  checkpointJson: t.sessionObservationCheckpoints.checkpointJson,
  updatedAt: t.sessionObservationCheckpoints.updatedAt,
})

type LeaseSelect = Pick<
  typeof sessionObservationCheckpoints.$inferSelect,
  | 'sessionId'
  | 'provider'
  | 'providerSessionId'
  | 'bindingVersion'
  | 'observationGeneration'
  | 'checkpointJson'
  | 'updatedAt'
>

// Every query this repository runs, prepared once per store [POD-6147].

const P = (name: string) => sql.placeholder(name)
const ckSessionIs = (t: StoreTables) =>
  eq(
    t.sessionObservationCheckpoints.sessionId,
    param(t.sessionObservationCheckpoints.sessionId, 'sessionId'),
  )
const tcSessionIs = (t: StoreTables) =>
  eq(
    t.sessionTerminalCandidates.sessionId,
    param(t.sessionTerminalCandidates.sessionId, 'sessionId'),
  )

const leaseOf = prepared((db, t) =>
  db
    .select(LEASE_COLUMNS(t))
    .from(t.sessionObservationCheckpoints)
    .where(inWorkspace(t.sessionObservationCheckpoints, ckSessionIs(t)))
    .prepare(),
)

const rebindReceiptOf = prepared((db, t) =>
  db
    .select({
      provider: t.sessionObservationRebinds.provider,
      fromProviderSessionId: t.sessionObservationRebinds.fromProviderSessionId,
      fromBindingVersion: t.sessionObservationRebinds.fromBindingVersion,
      fromObservationGeneration: t.sessionObservationRebinds.fromObservationGeneration,
      toProviderSessionId: t.sessionObservationRebinds.toProviderSessionId,
      resultingBindingVersion: t.sessionObservationRebinds.resultingBindingVersion,
      resultingObservationGeneration: t.sessionObservationRebinds.resultingObservationGeneration,
    })
    .from(t.sessionObservationRebinds)
    .where(
      inWorkspace(
        t.sessionObservationRebinds,
        eq(
          t.sessionObservationRebinds.sessionId,
          param(t.sessionObservationRebinds.sessionId, 'sessionId'),
        ),
      ),
    )
    .prepare(),
)

/** The checkpoints of a known set of sessions (POD-6160); tombstones and rows
 *  without a checkpoint excluded. */
const checkpointedLeasesOfIds = preparedFamily((db, t, size: number) =>
  db
    .select(LEASE_COLUMNS(t))
    .from(t.sessionObservationCheckpoints)
    .innerJoin(
      t.sessions,
      and(
        sameWorkspace(t.sessions, t.sessionObservationCheckpoints),
        eq(t.sessions.id, t.sessionObservationCheckpoints.sessionId),
      ),
    )
    .where(
      inWorkspace(
        t.sessionObservationCheckpoints,
        inListOf(t.sessionObservationCheckpoints.sessionId, size),
        isNull(t.sessions.deletedAt),
        isNotNull(t.sessionObservationCheckpoints.checkpointJson),
      ),
    )
    .prepare(),
)

/**
 * WHAT A SESSION RECORD READS OF ITS CHECKPOINT (POD-7575), and nothing else:
 * the schema version, the turn state, the provider time and the provider thread
 * id (`applyObservationCheckpointTo`), as one small JSON object built by the
 * database. The checkpoint's cursors, fence and accepted transition ids (about
 * 11 KB on a live install) stay in the database: a browser's session-list
 * rebuild read and parsed every one of them, 1-2.5 s per rebuild on dev.56. An
 * unreadable checkpoint reads as NULL, as `mapRow` reads it as none.
 */
const CHECKPOINT_RECORD_KEYS = ['schemaVersion', 'turnState', 'providerAt', 'providerSessionId']
function checkpointRecordFacts(db: StoreDrizzle, checkpoint: SQL): SQL<string | null> {
  const pg = dialectOf(db) === 'pg'
  const fields = sql.join(
    CHECKPOINT_RECORD_KEYS.map((key) =>
      pg
        ? sql`${sql.raw(`'${key}'`)}, ${checkpoint} -> ${sql.raw(`'${key}'`)}`
        : sql`${sql.raw(`'${key}'`)}, json_extract(${checkpoint}, ${sql.raw(`'$.${key}'`)})`,
    ),
    sql`, `,
  )
  return pg
    ? sql<
        string | null
      >`CASE WHEN json_typeof(${checkpoint}) = 'object' THEN json_build_object(${fields})::text END`
    : sql<string | null>`CASE WHEN json_valid(${checkpoint}) THEN json_object(${fields}) END`
}

/** {@link checkpointRecordFacts} of a known set of sessions; tombstones and rows
 *  without a checkpoint excluded, as {@link checkpointedLeasesOfIds}. */
const checkpointRecordFactsOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({
      sessionId: t.sessionObservationCheckpoints.sessionId,
      facts: checkpointRecordFacts(db, sql`${t.sessionObservationCheckpoints.checkpointJson}`),
    })
    .from(t.sessionObservationCheckpoints)
    .innerJoin(
      t.sessions,
      and(
        sameWorkspace(t.sessions, t.sessionObservationCheckpoints),
        eq(t.sessions.id, t.sessionObservationCheckpoints.sessionId),
      ),
    )
    .where(
      inWorkspace(
        t.sessionObservationCheckpoints,
        inListOf(t.sessionObservationCheckpoints.sessionId, size),
        isNull(t.sessions.deletedAt),
        isNotNull(t.sessionObservationCheckpoints.checkpointJson),
      ),
    )
    .prepare(),
)

/** The leases of a known set of sessions, checkpoint or not (POD-7036): the
 *  host sample's terminal-proof pass reads every candidate's at once. */
const leasesOfIds = preparedFamily((db, t, size: number) =>
  db
    .select(LEASE_COLUMNS(t))
    .from(t.sessionObservationCheckpoints)
    .where(
      inWorkspace(
        t.sessionObservationCheckpoints,
        inListOf(t.sessionObservationCheckpoints.sessionId, size),
      ),
    )
    .prepare(),
)

/** The terminal candidates of a known set of sessions (POD-7036). */
const terminalCandidatesOfIds = preparedFamily((db, t, size: number) =>
  db
    .select({
      sessionId: t.sessionTerminalCandidates.sessionId,
      proofJson: t.sessionTerminalCandidates.proofJson,
      confirmedAt: t.sessionTerminalCandidates.confirmedAt,
      consumedAt: t.sessionTerminalCandidates.consumedAt,
      updatedAt: t.sessionTerminalCandidates.updatedAt,
    })
    .from(t.sessionTerminalCandidates)
    .where(
      inWorkspace(
        t.sessionTerminalCandidates,
        inListOf(t.sessionTerminalCandidates.sessionId, size),
      ),
    )
    .prepare(),
)

const openLease = prepared((db, t) =>
  captureWrite(
    db
      .insert(t.sessionObservationCheckpoints)
      .values({
        workspaceId: WORKSPACE,
        sessionId: P('sessionId'),
        schemaVersion: 1,
        provider: P('provider'),
        providerSessionId: P('providerSessionId'),
        bindingVersion: 1,
        observationGeneration: 0,
        checkpointJson: null,
        updatedAt: P('updatedAt'),
      })
      // WAS `INSERT OR IGNORE`, and the two are NOT generally interchangeable
      // (spec rule 31). Measured on bun:sqlite: `OR IGNORE` suppresses UNIQUE,
      // PRIMARY KEY, NOT NULL and CHECK, while `DO NOTHING` suppresses only the
      // uniqueness conflict. Foreign keys do not enter it — NEITHER form
      // suppresses those, which is why "this table has no foreign keys" is the
      // wrong premise and is not the one relied on here.
      //
      // THE CONDITION IS THAT NO NOT NULL AND NO CHECK VIOLATION IS REACHABLE,
      // and on the shipped table it holds: no CHECK constraints, one index
      // (the primary key's own, which both forms suppress), and every NOT NULL
      // column here — schema_version, provider, binding_version,
      // observation_generation, updated_at — is supplied from a literal or a
      // non-nullable parameter. So the only violation either form can meet is
      // the primary key. The enumeration is in the commit message.
      .onConflictDoNothing(),
  ).prepare(),
)

const advanceLeaseGeneration = prepared((db, t) =>
  db
    .update(t.sessionObservationCheckpoints)
    .set({
      // Read-modify-write IN THE STATEMENT, not in the caller: the fence has
      // to advance atomically with respect to any other observer.
      observationGeneration: sql`${t.sessionObservationCheckpoints.observationGeneration} + 1`,
      providerSessionId: sql`COALESCE(${t.sessionObservationCheckpoints.providerSessionId}, ${P('providerSessionId')})`,
      updatedAt: P('updatedAt'),
    })
    .where(
      inWorkspace(
        t.sessionObservationCheckpoints,
        ckSessionIs(t),
        eq(
          t.sessionObservationCheckpoints.provider,
          param(t.sessionObservationCheckpoints.provider, 'provider'),
        ),
      ),
    )
    .prepare(),
)

const rebindLease = prepared((db, t) =>
  captureWrite(
    db
      .update(t.sessionObservationCheckpoints)
      .set({
        providerSessionId: P('nextProviderSessionId'),
        bindingVersion: P('nextBindingVersion'),
        observationGeneration: P('nextObservationGeneration'),
        checkpointJson: null,
        updatedAt: P('updatedAt'),
      })
      .where(
        inWorkspace(
          t.sessionObservationCheckpoints,
          ckSessionIs(t),
          eq(
            t.sessionObservationCheckpoints.provider,
            param(t.sessionObservationCheckpoints.provider, 'provider'),
          ),
          eq(
            t.sessionObservationCheckpoints.bindingVersion,
            param(t.sessionObservationCheckpoints.bindingVersion, 'bindingVersion'),
          ),
          eq(
            t.sessionObservationCheckpoints.observationGeneration,
            param(t.sessionObservationCheckpoints.observationGeneration, 'observationGeneration'),
          ),
          // THE FULL COMPARE-AND-SWAP: equal, or both NULL, which is what lets a
          // lease with no provider session id be rebound at all (`= NULL` would
          // match no row). `IS NOT DISTINCT FROM` says exactly that on both
          // engines; the long form `= ? OR (… IS NULL AND ? IS NULL)` gives
          // Postgres a bare parameter it cannot type.
          sql`${t.sessionObservationCheckpoints.providerSessionId} IS NOT DISTINCT FROM ${P('providerSessionId')}`,
        ),
      ),
  ).prepare(),
)

const rebindReceiptColumns = {
  provider: P('provider'),
  fromProviderSessionId: P('fromProviderSessionId'),
  fromBindingVersion: P('fromBindingVersion'),
  fromObservationGeneration: P('fromObservationGeneration'),
  toProviderSessionId: P('toProviderSessionId'),
  resultingBindingVersion: P('resultingBindingVersion'),
  resultingObservationGeneration: P('resultingObservationGeneration'),
  updatedAt: P('updatedAt'),
}

const upsertRebindReceipt = prepared((db, t) =>
  db
    .insert(t.sessionObservationRebinds)
    .values({ workspaceId: WORKSPACE, sessionId: P('sessionId'), ...rebindReceiptColumns })
    .onConflictDoUpdate({
      target: [t.sessionObservationRebinds.workspaceId, t.sessionObservationRebinds.sessionId],
      set: rebindReceiptColumns,
    })
    .prepare(),
)

const saveCheckpoint = prepared((db, t) =>
  captureWrite(
    db
      .update(t.sessionObservationCheckpoints)
      .set({
        providerSessionId: sql`COALESCE(${t.sessionObservationCheckpoints.providerSessionId}, ${P('providerSessionId')})`,
        checkpointJson: P('checkpointJson'),
        updatedAt: P('updatedAt'),
      })
      .where(
        inWorkspace(
          t.sessionObservationCheckpoints,
          ckSessionIs(t),
          eq(
            t.sessionObservationCheckpoints.provider,
            param(t.sessionObservationCheckpoints.provider, 'provider'),
          ),
          eq(
            t.sessionObservationCheckpoints.bindingVersion,
            param(t.sessionObservationCheckpoints.bindingVersion, 'bindingVersion'),
          ),
          eq(
            t.sessionObservationCheckpoints.observationGeneration,
            param(t.sessionObservationCheckpoints.observationGeneration, 'observationGeneration'),
          ),
          // NOT the same predicate as `rebindLease`'s: an UNSET provider session
          // id accepts any writer, where a set one must match. Keeping the two
          // spelled differently is the point.
          sql`(${t.sessionObservationCheckpoints.providerSessionId} IS NULL OR ${t.sessionObservationCheckpoints.providerSessionId} = ${P('providerSessionId')})`,
        ),
      ),
  ).prepare(),
)

const terminalCandidateOf = prepared((db, t) =>
  db
    .select({
      proofJson: t.sessionTerminalCandidates.proofJson,
      confirmedAt: t.sessionTerminalCandidates.confirmedAt,
      consumedAt: t.sessionTerminalCandidates.consumedAt,
      updatedAt: t.sessionTerminalCandidates.updatedAt,
    })
    .from(t.sessionTerminalCandidates)
    .where(inWorkspace(t.sessionTerminalCandidates, tcSessionIs(t)))
    .prepare(),
)

const upsertTerminalProof = prepared((db, t) =>
  db
    .insert(t.sessionTerminalCandidates)
    .values({
      workspaceId: WORKSPACE,
      sessionId: P('sessionId'),
      proofJson: P('proofJson'),
      confirmedAt: null,
      consumedAt: null,
      updatedAt: P('at'),
    })
    .onConflictDoUpdate({
      target: [t.sessionTerminalCandidates.workspaceId, t.sessionTerminalCandidates.sessionId],
      set: { proofJson: P('proofJson'), confirmedAt: null, consumedAt: null, updatedAt: P('at') },
    })
    .prepare(),
)

const confirmTerminalProof = prepared((db, t) =>
  db
    .update(t.sessionTerminalCandidates)
    .set({
      proofJson: P('proofJson'),
      // COALESCE, so a second confirmation keeps the FIRST instant.
      confirmedAt: sql`COALESCE(${t.sessionTerminalCandidates.confirmedAt}, ${P('confirmedAt')})`,
      updatedAt: P('at'),
    })
    .where(
      inWorkspace(
        t.sessionTerminalCandidates,
        tcSessionIs(t),
        isNull(t.sessionTerminalCandidates.consumedAt),
      ),
    )
    .prepare(),
)

const renewTerminalProof = prepared((db, t) =>
  db
    .update(t.sessionTerminalCandidates)
    .set({ proofJson: P('proofJson'), updatedAt: P('at') })
    .where(
      inWorkspace(
        t.sessionTerminalCandidates,
        tcSessionIs(t),
        // The PREVIOUS proof text is part of the guard: a renewal only lands
        // on the exact row it read, so a concurrent write cannot be
        // overwritten by a translation of a proof that is no longer there. As
        // text on both engines: Postgres's `json` has no equality (design 2.3 rule 7).
        sql`CAST(${t.sessionTerminalCandidates.proofJson} AS TEXT) = ${param(
          t.sessionTerminalCandidates.proofJson,
          'previousProof',
        )}`,
        sql`${t.sessionTerminalCandidates.confirmedAt} IS NOT NULL`,
        isNull(t.sessionTerminalCandidates.consumedAt),
      ),
    )
    .prepare(),
)

const consumeTerminalProof = prepared((db, t) =>
  db
    .update(t.sessionTerminalCandidates)
    .set({ consumedAt: P('at'), updatedAt: P('at') })
    .where(
      inWorkspace(
        t.sessionTerminalCandidates,
        tcSessionIs(t),
        sql`${t.sessionTerminalCandidates.confirmedAt} IS NOT NULL`,
        isNull(t.sessionTerminalCandidates.consumedAt),
      ),
    )
    .prepare(),
)

const deleteTerminalCandidate = prepared((db, t) =>
  db
    .delete(t.sessionTerminalCandidates)
    .where(inWorkspace(t.sessionTerminalCandidates, tcSessionIs(t)))
    .prepare(),
)

const deleteLease = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.sessionObservationCheckpoints)
      .where(inWorkspace(t.sessionObservationCheckpoints, ckSessionIs(t))),
  ).prepare(),
)

/** A stored terminal candidate, or null when its proof cannot be read.
 *  QUARANTINE, as `mapRow`: an unreadable proof reads as no proof. */
function candidateOfRow(
  sessionId: SessionId,
  row: {
    proofJson: string
    confirmedAt: string | null
    consumedAt: string | null
    updatedAt: string
  },
): TerminalCandidateRecord | null {
  try {
    const proof = JSON.parse(row.proofJson) as Omit<
      TerminalCandidateRecord,
      'confirmedAt' | 'consumedAt' | 'updatedAt'
    >
    if (proof.facts?.schemaVersion !== 1 || proof.facts.sessionId !== sessionId) return null
    return {
      ...proof,
      confirmedAt: row.confirmedAt,
      consumedAt: row.consumedAt,
      updatedAt: row.updatedAt,
    }
  } catch {
    return null
  }
}

/** Durable causal observer leases and checkpoints. */
export class ObservationCheckpointsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query builder every method below reads through [spec rules 34, 34a].
   *
   * A GETTER, not a field assigned in the constructor: rule 35 makes transaction
   * routing ambient, so this has to resolve the ENCLOSING transaction on every
   * access, and a field frozen at construction never could. B1 changes this one
   * line; no call site moves.
   */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  private async mapRow(r: LeaseSelect): Promise<ObservationLeaseRecord | null> {
    const provider = ObservationProvider.safeParse(r.provider)
    if (!provider.success) {
      log.warn('ignoring an observation lease with an invalid provider', {
        sessionId: String(r.sessionId),
        provider: r.provider,
      })
      return null
    }
    let checkpoint: ObservationLeaseRecord['checkpoint'] = null
    if (r.checkpointJson != null) {
      try {
        // QUARANTINE, NOT `mode: 'json'` (spec §6 rule 4). The column is plain
        // `text()`: a corrupt checkpoint is logged and read as absent, where a
        // JSON column would throw and take the lease with it.
        const parsed = SessionObservationCheckpointV1.safeParse(JSON.parse(r.checkpointJson))
        if (!parsed.success) throw new Error(parsed.error.message)
        checkpoint = parsed.data
      } catch (err) {
        log.warn('ignoring a corrupt observation checkpoint', {
          err,
          sessionId: String(r.sessionId),
        })
      }
    }
    return {
      sessionId: r.sessionId,
      provider: provider.data,
      providerSessionId: r.providerSessionId,
      bindingVersion: r.bindingVersion,
      observationGeneration: r.observationGeneration,
      checkpoint,
      updatedAt: r.updatedAt,
    }
  }

  private async read(sessionId: SessionId): Promise<ObservationLeaseRecord | null> {
    const row = await leaseOf(this.db).get({ sessionId })
    return row ? await this.mapRow(row) : null
  }

  private async readRebindReceipt(sessionId: SessionId): Promise<{
    provider: ObservationLeaseRecord['provider']
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    fromProviderSessionId: string | null
    fromBindingVersion: number
    fromObservationGeneration: number
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    toProviderSessionId: string
    resultingBindingVersion: number
    resultingObservationGeneration: number
  } | null> {
    const row = await rebindReceiptOf(this.db).get({ sessionId })
    if (!row) return null
    const provider = ObservationProvider.safeParse(row.provider)
    if (!provider.success) return null
    return {
      provider: provider.data,
      fromProviderSessionId: row.fromProviderSessionId,
      fromBindingVersion: row.fromBindingVersion,
      fromObservationGeneration: row.fromObservationGeneration,
      toProviderSessionId: row.toProviderSessionId,
      resultingBindingVersion: row.resultingBindingVersion,
      resultingObservationGeneration: row.resultingObservationGeneration,
    }
  }

  /**
   * The checkpoints of a known set of live sessions (POD-6160): what a durable
   * session record is restored with, one statement per 500 ids. There is no
   * read of every session's checkpoint (POD-6172).
   */
  async checkpointsOf(
    sessionIds: readonly SessionId[],
  ): Promise<Map<SessionId, SessionObservationCheckpointV1>> {
    const checkpoints = new Map<SessionId, SessionObservationCheckpointV1>()
    for (let at = 0; at < sessionIds.length; at += 500) {
      const chunk = sessionIds.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await checkpointedLeasesOfIds(this.db, size).all(
        inListValues(chunk, size),
      )) {
        const lease = await this.mapRow(row)
        if (lease?.checkpoint) checkpoints.set(lease.sessionId, lease.checkpoint)
      }
    }
    return checkpoints
  }

  /**
   * {@link checkpointsOf} narrowed to what a durable session record reads
   * (POD-7575): the turn state, provider time and provider thread id, built
   * by the database, so a listing reads a few hundred bytes per session, not
   * the whole checkpoint. One statement per 500 ids. Quarantined like the
   * full read: an unreadable value is logged and the session has none.
   */
  async recordFactsOf(
    sessionIds: readonly SessionId[],
  ): Promise<Map<SessionId, CheckpointRecordFacts>> {
    const facts = new Map<SessionId, CheckpointRecordFacts>()
    for (let at = 0; at < sessionIds.length; at += 500) {
      const chunk = sessionIds.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await checkpointRecordFactsOfIds(this.db, size).all(
        inListValues(chunk, size),
      )) {
        if (row.facts == null) continue
        try {
          const parsed = CheckpointRecordFacts.safeParse(JSON.parse(row.facts))
          if (!parsed.success) throw new Error(parsed.error.message)
          facts.set(row.sessionId, {
            turnState: parsed.data.turnState,
            providerAt: parsed.data.providerAt,
            providerSessionId: parsed.data.providerSessionId,
          })
        } catch (err) {
          log.warn('ignoring a corrupt observation checkpoint', {
            err,
            sessionId: String(row.sessionId),
          })
        }
      }
    }
    return facts
  }

  async get(sessionId: SessionId): Promise<ObservationLeaseRecord | null> {
    return await this.read(sessionId)
  }

  /** {@link get} for a known set of sessions, one statement per 500 ids
   *  (POD-7036). A session with no lease is absent. */
  async leasesOf(
    sessionIds: readonly SessionId[],
  ): Promise<Map<SessionId, ObservationLeaseRecord>> {
    const leases = new Map<SessionId, ObservationLeaseRecord>()
    const unique = [...new Set(sessionIds)]
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await leasesOfIds(this.db, size).all(inListValues(chunk, size))) {
        const lease = await this.mapRow(row)
        if (lease) leases.set(lease.sessionId, lease)
      }
    }
    return leases
  }

  /**
   * Fence a new observer before spawn/reattach is sent. Existing exact provider
   * identity is never replaced by a conflicting resume hint.
   */
  async advanceGeneration(
    sessionId: SessionId,
    provider: ObservationLeaseRecord['provider'],
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    providerSessionId: string | null,
  ): Promise<ObservationLeaseRecord> {
    return await this.createOrJoinTransaction(async () => {
      const updatedAt = new Date().toISOString()
      // `DO NOTHING`, not `OR IGNORE`: see `openLease`.
      await openLease(this.db).run({ sessionId, provider, providerSessionId, updatedAt })
      await advanceLeaseGeneration(this.db).run({
        sessionId,
        provider,
        providerSessionId,
        updatedAt,
      })
      // A SPENT proof does not survive its observer's life. Consumption is the
      // last act of one hibernation; a fresh fence means the session is being
      // observed again, and `confirmTerminalCandidate` refuses to touch a
      // consumed row — leaving it would make a revived session permanently
      // ineligible with no path back short of a new user turn (POD-1879).
      // Unconsumed proofs are LEFT ALONE: an exact reattachment replay renews
      // them through `renewTerminalCandidate`, which is strictly fenced.
      const candidate = await this.getTerminalCandidate(sessionId)
      if (candidate?.consumedAt) await this.cancelTerminalCandidate(sessionId)
      const lease = await this.read(sessionId)
      if (!lease || lease.provider !== provider) {
        throw new Error(`unable to advance observation generation for ${sessionId}`)
      }
      return lease
    })
  }

  /**
   * Atomically replace one exact native provider binding. Both fences advance,
   * so observations and acknowledgements from the predecessor become inert.
   * Duplicate old→already-current-next requests return the durable current
   * lease without advancing again, including after process restart.
   */
  async rebindExact(input: {
    sessionId: SessionId
    provider: ObservationLeaseRecord['provider']
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    providerSessionId: string | null
    bindingVersion: number
    observationGeneration: number
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    nextProviderSessionId: string
  }): Promise<ObservationRebindResult> {
    return await this.createOrJoinTransaction(async () => {
      const current = await this.read(input.sessionId)
      if (!current) throw new Error(`missing observation lease for ${input.sessionId}`)
      if (current.provider !== input.provider) {
        return { kind: 'rejected', rejectionReason: 'provider_binding_mismatch', lease: current }
      }
      if (
        current.providerSessionId === input.nextProviderSessionId &&
        current.providerSessionId === input.providerSessionId &&
        current.bindingVersion === input.bindingVersion &&
        current.observationGeneration === input.observationGeneration
      ) {
        return { kind: 'accepted', disposition: 'unchanged', lease: current }
      }
      const receipt = await this.readRebindReceipt(input.sessionId)
      if (
        receipt?.provider === input.provider &&
        receipt.fromProviderSessionId === input.providerSessionId &&
        receipt.fromBindingVersion === input.bindingVersion &&
        receipt.fromObservationGeneration === input.observationGeneration &&
        receipt.toProviderSessionId === input.nextProviderSessionId &&
        current.providerSessionId === input.nextProviderSessionId &&
        current.bindingVersion === receipt.resultingBindingVersion &&
        current.observationGeneration >= receipt.resultingObservationGeneration
      ) {
        return { kind: 'accepted', disposition: 'duplicate', lease: current }
      }
      if (current.observationGeneration !== input.observationGeneration) {
        return {
          kind: 'rejected',
          rejectionReason: 'stale_observer_generation',
          lease: current,
        }
      }
      if (
        current.providerSessionId !== input.providerSessionId ||
        current.bindingVersion !== input.bindingVersion
      ) {
        return { kind: 'rejected', rejectionReason: 'provider_binding_mismatch', lease: current }
      }

      const bindingVersion = current.bindingVersion + 1
      const observationGeneration = current.observationGeneration + 1
      const updatedAt = new Date().toISOString()
      const result = await rebindLease(this.db).run({
        sessionId: input.sessionId,
        provider: input.provider,
        bindingVersion: input.bindingVersion,
        observationGeneration: input.observationGeneration,
        providerSessionId: input.providerSessionId,
        nextProviderSessionId: input.nextProviderSessionId,
        nextBindingVersion: bindingVersion,
        nextObservationGeneration: observationGeneration,
        updatedAt,
      })
      if (Number(result.changes) !== 1) {
        throw new Error(`observation rebind lease changed for ${input.sessionId}`)
      }
      const receiptRow = {
        sessionId: input.sessionId,
        provider: input.provider,
        fromProviderSessionId: input.providerSessionId,
        fromBindingVersion: input.bindingVersion,
        fromObservationGeneration: input.observationGeneration,
        toProviderSessionId: input.nextProviderSessionId,
        resultingBindingVersion: bindingVersion,
        resultingObservationGeneration: observationGeneration,
        updatedAt,
      }
      await upsertRebindReceipt(this.db).run(receiptRow)
      await this.cancelTerminalCandidate(input.sessionId)
      const lease = await this.read(input.sessionId)
      if (!lease) throw new Error(`missing rebound observation lease for ${input.sessionId}`)
      return { kind: 'accepted', disposition: 'advanced', lease }
    })
  }

  /** Persist only against the still-current lease; stale sockets cannot win. */
  async save(checkpoint: SessionObservationCheckpointV1): Promise<void> {
    const result = await saveCheckpoint(this.db).run({
      sessionId: checkpoint.podiumSessionId,
      provider: checkpoint.provider,
      bindingVersion: checkpoint.bindingVersion,
      observationGeneration: checkpoint.lifecycleObservationGeneration,
      providerSessionId: checkpoint.providerSessionId,
      checkpointJson: JSON.stringify(checkpoint),
      updatedAt: checkpoint.acceptedAt,
    })
    if (Number(result.changes) !== 1) {
      throw new Error(`observation checkpoint lease changed for ${checkpoint.podiumSessionId}`)
    }
  }

  async getTerminalCandidate(sessionId: SessionId): Promise<TerminalCandidateRecord | null> {
    const row = await terminalCandidateOf(this.db).get({ sessionId })
    return row ? candidateOfRow(sessionId, row) : null
  }

  /** {@link getTerminalCandidate} for a known set of sessions, one statement
   *  per 500 ids (POD-7036). A session with no readable candidate is absent. */
  async terminalCandidatesOf(
    sessionIds: readonly SessionId[],
  ): Promise<Map<SessionId, TerminalCandidateRecord>> {
    const candidates = new Map<SessionId, TerminalCandidateRecord>()
    const unique = [...new Set(sessionIds)]
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await terminalCandidatesOfIds(this.db, size).all(
        inListValues(chunk, size),
      )) {
        const candidate = candidateOfRow(row.sessionId, row)
        if (candidate) candidates.set(row.sessionId, candidate)
      }
    }
    return candidates
  }

  /** Pass one for a genuinely live terminal edge. Bootstrap/replay never call this. */
  async recordTerminalCandidate(facts: TerminalCandidateFacts, at: string): Promise<void> {
    const proof = {
      facts,
      firstLivePollSequence: 0,
      lastLivePollSequence: 0,
    }
    await this.upsertProof(facts.sessionId, proof, at)
  }

  /**
   * Write a fresh proof, CLEARING both stamps — the shape `record` and `arm`
   * share. It was two identical statements before the conversion; they are one
   * here because a difference between them would have been a defect either way.
   */
  private async upsertProof(sessionId: SessionId, proof: unknown, at: string): Promise<void> {
    const proofJson = JSON.stringify(proof)
    await upsertTerminalProof(this.db).run({ sessionId, proofJson, at })
  }

  /** Arm pass one at this observer sequence, discarding whatever was there. */
  private async armTerminalCandidate(
    facts: TerminalCandidateFacts,
    livePollSequence: number,
    at: string,
  ): Promise<void> {
    const proof = {
      facts,
      firstLivePollSequence: livePollSequence,
      lastLivePollSequence: livePollSequence,
    }
    await this.upsertProof(facts.sessionId, proof, at)
  }

  /**
   * One unchanged live observer receipt records pass one for a legacy/bootstrap
   * terminal; a strictly later unchanged receipt records pass two. A changed
   * causal snapshot resets rather than inheriting an older proof.
   *
   * REHABILITATION (POD-1879). Two states used to wedge a still-idle session
   * out of hibernation forever, because both make every later receipt inert:
   * a proof already CONSUMED by a previous hibernation, and an observer whose
   * poll counter restarted below the sequence we last stored. Both are repaired
   * by re-arming PASS ONE — never by confirming — so a rehabilitated proof
   * still has to earn its confirmation from live receipts under the current
   * fence. The consumed row is superseded only from a strictly newer observer
   * generation: within one generation that exact terminal is genuinely spent.
   */
  async confirmTerminalCandidate(
    facts: TerminalCandidateFacts,
    livePollSequence: number,
    at: string,
  ): Promise<'recorded' | 'confirmed' | 'unchanged' | 'rehabilitated'> {
    return await this.createOrJoinTransaction(async () => {
      const current = await this.getTerminalCandidate(facts.sessionId)
      if (current?.consumedAt) {
        if (facts.observerGeneration <= current.facts.observerGeneration) return 'unchanged'
        await this.armTerminalCandidate(facts, livePollSequence, at)
        return 'rehabilitated'
      }
      if (!current || !sameFacts(current.facts, facts)) {
        await this.armTerminalCandidate(facts, livePollSequence, at)
        return 'recorded'
      }
      if (current.confirmedAt) return 'unchanged'
      if (livePollSequence < current.firstLivePollSequence) {
        // The observer's counter only ever rises within one observer life, so a
        // lower sequence is a RESTARTED counter, not a replayed receipt. Left
        // alone it can never clear `lastLivePollSequence` again.
        await this.armTerminalCandidate(facts, livePollSequence, at)
        return 'rehabilitated'
      }
      if (livePollSequence <= current.lastLivePollSequence) return 'unchanged'
      const confirmed =
        current.firstLivePollSequence === 0 || livePollSequence > current.firstLivePollSequence
      const proof = {
        facts,
        firstLivePollSequence: current.firstLivePollSequence,
        lastLivePollSequence: livePollSequence,
      }
      await confirmTerminalProof(this.db).run({
        sessionId: facts.sessionId,
        proofJson: JSON.stringify(proof),
        confirmedAt: confirmed ? at : null,
        at,
      })
      return confirmed ? 'confirmed' : 'recorded'
    })
  }

  /**
   * Translate one confirmed proof across an exact, freshly fenced reattachment.
   * The caller supplies the current facts only after the daemon has replayed the
   * durable checkpoint under the new observer generation. Generation and PTY
   * repaint counters may advance; every causal/work fact must remain identical.
   */
  async renewTerminalCandidate(facts: TerminalCandidateFacts, at: string): Promise<boolean> {
    return await this.createOrJoinTransaction(async () => {
      const current = await this.getTerminalCandidate(facts.sessionId)
      if (
        !current?.confirmedAt ||
        current.consumedAt ||
        !sameFactsAcrossReattachment(current.facts, facts)
      )
        return false
      const lease = await this.read(facts.sessionId)
      const checkpoint = lease?.checkpoint
      if (
        !lease ||
        lease.provider !== facts.provider ||
        lease.providerSessionId !== facts.providerSessionId ||
        lease.bindingVersion !== facts.bindingVersion ||
        lease.observationGeneration !== facts.observerGeneration ||
        checkpoint?.lastTransitionId !== facts.lastTransitionId ||
        checkpoint.terminalFence?.transitionId !== facts.terminalTransitionId ||
        JSON.stringify(checkpoint.providerCursor) !== JSON.stringify(facts.providerCursor)
      )
        return false
      const previousProof = JSON.stringify({
        facts: current.facts,
        firstLivePollSequence: current.firstLivePollSequence,
        lastLivePollSequence: current.lastLivePollSequence,
      })
      const proof = {
        facts,
        firstLivePollSequence: current.firstLivePollSequence,
        lastLivePollSequence: current.lastLivePollSequence,
      }
      const result = await renewTerminalProof(this.db).run({
        sessionId: facts.sessionId,
        proofJson: JSON.stringify(proof),
        previousProof,
        at,
      })
      return Number(result.changes) === 1
    })
  }

  /** Final apply-time compare-and-consume; callers run this in the session-row transaction. */
  async consumeTerminalCandidate(facts: TerminalCandidateFacts, at: string): Promise<boolean> {
    const current = await this.getTerminalCandidate(facts.sessionId)
    if (!current?.confirmedAt || current.consumedAt || !sameFacts(current.facts, facts))
      return false
    const lease = await this.read(facts.sessionId)
    const checkpoint = lease?.checkpoint
    if (
      !lease ||
      lease.provider !== facts.provider ||
      lease.providerSessionId !== facts.providerSessionId ||
      lease.bindingVersion !== facts.bindingVersion ||
      lease.observationGeneration !== facts.observerGeneration ||
      checkpoint?.lastTransitionId !== facts.lastTransitionId ||
      checkpoint.terminalFence?.transitionId !== facts.terminalTransitionId ||
      JSON.stringify(checkpoint.providerCursor) !== JSON.stringify(facts.providerCursor)
    )
      return false
    const result = await consumeTerminalProof(this.db).run({ sessionId: facts.sessionId, at })
    return Number(result.changes) === 1
  }

  async cancelTerminalCandidate(sessionId: SessionId): Promise<void> {
    await deleteTerminalCandidate(this.db).run({ sessionId })
  }

  async purge(sessionId: SessionId): Promise<void> {
    await deleteLease(this.db).run({ sessionId })
  }
}
