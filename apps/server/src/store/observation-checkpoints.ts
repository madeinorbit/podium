import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { ObservationProvider, SessionObservationCheckpointV1 } from '@podium/protocol'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  sessions,
  sessionObservationCheckpoints,
  sessionObservationRebinds,
  sessionTerminalCandidates,
} from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { inListOf, inListSize, inListValues, param, prepared, preparedFamily } from './executor/sync-drizzle'
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
const LEASE_COLUMNS = {
  sessionId: sessionObservationCheckpoints.sessionId,
  provider: sessionObservationCheckpoints.provider,
  providerSessionId: sessionObservationCheckpoints.providerSessionId,
  bindingVersion: sessionObservationCheckpoints.bindingVersion,
  observationGeneration: sessionObservationCheckpoints.observationGeneration,
  checkpointJson: sessionObservationCheckpoints.checkpointJson,
  updatedAt: sessionObservationCheckpoints.updatedAt,
}

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
const ck = sessionObservationCheckpoints
const tc = sessionTerminalCandidates
const ckSessionIs = () => eq(ck.sessionId, param(ck.sessionId, 'sessionId'))
const tcSessionIs = () => eq(tc.sessionId, param(tc.sessionId, 'sessionId'))

const leaseOf = prepared((db: StoreDrizzle) =>
  db.select(LEASE_COLUMNS).from(ck).where(ckSessionIs()).prepare(),
)

const rebindReceiptOf = prepared((db: StoreDrizzle) =>
  db
    .select({
      provider: sessionObservationRebinds.provider,
      fromProviderSessionId: sessionObservationRebinds.fromProviderSessionId,
      fromBindingVersion: sessionObservationRebinds.fromBindingVersion,
      fromObservationGeneration: sessionObservationRebinds.fromObservationGeneration,
      toProviderSessionId: sessionObservationRebinds.toProviderSessionId,
      resultingBindingVersion: sessionObservationRebinds.resultingBindingVersion,
      resultingObservationGeneration: sessionObservationRebinds.resultingObservationGeneration,
    })
    .from(sessionObservationRebinds)
    .where(eq(sessionObservationRebinds.sessionId, param(sessionObservationRebinds.sessionId, 'sessionId')))
    .prepare(),
)

const checkpointedLiveLeases = prepared((db: StoreDrizzle) =>
  db
    .select(LEASE_COLUMNS)
    .from(ck)
    .innerJoin(sessions, eq(sessions.id, ck.sessionId))
    .where(and(isNull(sessions.deletedAt), isNotNull(ck.checkpointJson)))
    .prepare(),
)

/** The checkpoints of a known set of sessions (POD-6160); tombstones excluded
 *  exactly as {@link checkpointedLiveLeases} excludes them. */
const checkpointedLeasesOfIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select(LEASE_COLUMNS)
    .from(ck)
    .innerJoin(sessions, eq(sessions.id, ck.sessionId))
    .where(and(inListOf(ck.sessionId, size), isNull(sessions.deletedAt), isNotNull(ck.checkpointJson)))
    .prepare(),
)

const openLease = prepared((db: StoreDrizzle) =>
  db
    .insert(ck)
    .values({
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
    .onConflictDoNothing()
    .prepare(),
)

const advanceLeaseGeneration = prepared((db: StoreDrizzle) =>
  db
    .update(ck)
    .set({
      // Read-modify-write IN THE STATEMENT, not in the caller: the fence has
      // to advance atomically with respect to any other observer.
      observationGeneration: sql`${ck.observationGeneration} + 1`,
      providerSessionId: sql`COALESCE(${ck.providerSessionId}, ${P('providerSessionId')})`,
      updatedAt: P('updatedAt'),
    })
    .where(and(ckSessionIs(), eq(ck.provider, param(ck.provider, 'provider'))))
    .prepare(),
)

const rebindLease = prepared((db: StoreDrizzle) =>
  db
    .update(ck)
    .set({
      providerSessionId: P('nextProviderSessionId'),
      bindingVersion: P('nextBindingVersion'),
      observationGeneration: P('nextObservationGeneration'),
      checkpointJson: null,
      updatedAt: P('updatedAt'),
    })
    .where(
      and(
        ckSessionIs(),
        eq(ck.provider, param(ck.provider, 'provider')),
        eq(ck.bindingVersion, param(ck.bindingVersion, 'bindingVersion')),
        eq(ck.observationGeneration, param(ck.observationGeneration, 'observationGeneration')),
        // THE FULL COMPARE-AND-SWAP, reproduced rather than simplified: the
        // `IS NULL AND ? IS NULL` arm is what lets a lease with no provider
        // session id be rebound at all, and `= NULL` would match no row.
        sql`(${ck.providerSessionId} = ${P('providerSessionId')} OR (${ck.providerSessionId} IS NULL AND ${P('providerSessionId')} IS NULL))`,
      ),
    )
    .prepare(),
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

const upsertRebindReceipt = prepared((db: StoreDrizzle) =>
  db
    .insert(sessionObservationRebinds)
    .values({ sessionId: P('sessionId'), ...rebindReceiptColumns })
    .onConflictDoUpdate({ target: sessionObservationRebinds.sessionId, set: rebindReceiptColumns })
    .prepare(),
)

const saveCheckpoint = prepared((db: StoreDrizzle) =>
  db
    .update(ck)
    .set({
      providerSessionId: sql`COALESCE(${ck.providerSessionId}, ${P('providerSessionId')})`,
      checkpointJson: P('checkpointJson'),
      updatedAt: P('updatedAt'),
    })
    .where(
      and(
        ckSessionIs(),
        eq(ck.provider, param(ck.provider, 'provider')),
        eq(ck.bindingVersion, param(ck.bindingVersion, 'bindingVersion')),
        eq(ck.observationGeneration, param(ck.observationGeneration, 'observationGeneration')),
        // NOT the same predicate as `rebindLease`'s: an UNSET provider session
        // id accepts any writer, where a set one must match. Keeping the two
        // spelled differently is the point.
        sql`(${ck.providerSessionId} IS NULL OR ${ck.providerSessionId} = ${P('providerSessionId')})`,
      ),
    )
    .prepare(),
)

const terminalCandidateOf = prepared((db: StoreDrizzle) =>
  db
    .select({
      proofJson: tc.proofJson,
      confirmedAt: tc.confirmedAt,
      consumedAt: tc.consumedAt,
      updatedAt: tc.updatedAt,
    })
    .from(tc)
    .where(tcSessionIs())
    .prepare(),
)

const upsertTerminalProof = prepared((db: StoreDrizzle) =>
  db
    .insert(tc)
    .values({
      sessionId: P('sessionId'),
      proofJson: P('proofJson'),
      confirmedAt: null,
      consumedAt: null,
      updatedAt: P('at'),
    })
    .onConflictDoUpdate({
      target: tc.sessionId,
      set: { proofJson: P('proofJson'), confirmedAt: null, consumedAt: null, updatedAt: P('at') },
    })
    .prepare(),
)

const confirmTerminalProof = prepared((db: StoreDrizzle) =>
  db
    .update(tc)
    .set({
      proofJson: P('proofJson'),
      // COALESCE, so a second confirmation keeps the FIRST instant.
      confirmedAt: sql`COALESCE(${tc.confirmedAt}, ${P('confirmedAt')})`,
      updatedAt: P('at'),
    })
    .where(and(tcSessionIs(), isNull(tc.consumedAt)))
    .prepare(),
)

const renewTerminalProof = prepared((db: StoreDrizzle) =>
  db
    .update(tc)
    .set({ proofJson: P('proofJson'), updatedAt: P('at') })
    .where(
      and(
        tcSessionIs(),
        // The PREVIOUS proof text is part of the guard: a renewal only lands
        // on the exact row it read, so a concurrent write cannot be
        // overwritten by a translation of a proof that is no longer there.
        eq(tc.proofJson, param(tc.proofJson, 'previousProof')),
        sql`${tc.confirmedAt} IS NOT NULL`,
        isNull(tc.consumedAt),
      ),
    )
    .prepare(),
)

const consumeTerminalProof = prepared((db: StoreDrizzle) =>
  db
    .update(tc)
    .set({ consumedAt: P('at'), updatedAt: P('at') })
    .where(and(tcSessionIs(), sql`${tc.confirmedAt} IS NOT NULL`, isNull(tc.consumedAt)))
    .prepare(),
)

const deleteTerminalCandidate = prepared((db: StoreDrizzle) =>
  db.delete(tc).where(tcSessionIs()).prepare(),
)

const deleteLease = prepared((db: StoreDrizzle) => db.delete(ck).where(ckSessionIs()).prepare())

/** Durable causal observer leases and checkpoints [spec:SP-cdb2]. */
export class ObservationCheckpointsRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
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
  protected get db() {
    return this.rootDb
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
   * The checkpoint of every live (not tombstoned) session that has one, read
   * once at boot to restore the session map's agent state [POD-6159]. Nothing
   * keeps the result: every later read is {@link get}. It goes when the session
   * map itself stops being a copy of the table (design §6).
   */
  async checkpointsOfLiveSessions(): Promise<Map<SessionId, SessionObservationCheckpointV1>> {
    const rows = await checkpointedLiveLeases(this.db).all()
    const checkpoints = new Map<SessionId, SessionObservationCheckpointV1>()
    for (const row of rows) {
      const lease = await this.mapRow(row)
      if (lease?.checkpoint) checkpoints.set(lease.sessionId, lease.checkpoint)
    }
    return checkpoints
  }

  /**
   * {@link checkpointsOfLiveSessions} for a known set of sessions (POD-6160):
   * what a durable session record is restored with, one statement per 500 ids.
   */
  async checkpointsOf(
    sessionIds: readonly SessionId[],
  ): Promise<Map<SessionId, SessionObservationCheckpointV1>> {
    const checkpoints = new Map<SessionId, SessionObservationCheckpointV1>()
    for (let at = 0; at < sessionIds.length; at += 500) {
      const chunk = sessionIds.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await checkpointedLeasesOfIds(this.db, size).all(inListValues(chunk, size))) {
        const lease = await this.mapRow(row)
        if (lease?.checkpoint) checkpoints.set(lease.sessionId, lease.checkpoint)
      }
    }
    return checkpoints
  }

  async get(sessionId: SessionId): Promise<ObservationLeaseRecord | null> {
    return await this.read(sessionId)
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
      await advanceLeaseGeneration(this.db).run({ sessionId, provider, providerSessionId, updatedAt })
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
   * lease without advancing again, including after process restart. [spec:SP-cdb2]
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
    if (!row) return null
    try {
      // QUARANTINE, as `mapRow`: an unreadable proof reads as no proof.
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
