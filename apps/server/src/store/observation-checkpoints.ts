import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { ObservationProvider, SessionObservationCheckpointV1 } from '@podium/protocol'
import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  sessionObservationCheckpoints,
  sessionObservationRebinds,
  sessionTerminalCandidates,
} from '../migrations/schema'
import type { SyncQueries } from './executor/sync-drizzle'
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

/** Durable causal observer leases and checkpoints [spec:SP-cdb2]. */
export class ObservationCheckpointsRepository {
  constructor(private readonly queries: SyncQueries) {}

  /**
   * The query builder every method below reads through [spec rules 34, 34a].
   *
   * A GETTER, not a field assigned in the constructor: rule 35 makes transaction
   * routing ambient, so this has to resolve the ENCLOSING transaction on every
   * access, and a field frozen at construction never could. B1 changes this one
   * line; no call site moves.
   */
  protected get db() {
    return this.queries.db
  }

  /**
   * The synchronous span this file used to get from the runtime helper directly,
   * routed through the store's port so the executor knows the span exists.
   *
   * AN ARROW FIELD, not `this.transact = queries.transact` [spec rule 34a,
   * POD-3396's finding]. Assigning it across works only while the implementation
   * ignores its own `this` — which today's closure does and rule 35's adapter
   * over drizzle's transaction will not. It would then break as a detached
   * method, silently. One closure per instance is the price.
   */
  protected transact = <T>(fn: () => T): T => this.queries.transact(fn)

  private mapRow(r: LeaseSelect): ObservationLeaseRecord | null {
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

  private read(sessionId: SessionId): ObservationLeaseRecord | null {
    const row = this.db
      .select(LEASE_COLUMNS)
      .from(sessionObservationCheckpoints)
      .where(eq(sessionObservationCheckpoints.sessionId, sessionId))
      .get()
    return row ? this.mapRow(row) : null
  }

  private readRebindReceipt(sessionId: SessionId): {
    provider: ObservationLeaseRecord['provider']
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    fromProviderSessionId: string | null
    fromBindingVersion: number
    fromObservationGeneration: number
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    toProviderSessionId: string
    resultingBindingVersion: number
    resultingObservationGeneration: number
  } | null {
    const row = this.db
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
      .where(eq(sessionObservationRebinds.sessionId, sessionId))
      .get()
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

  loadAll(): ObservationLeaseRecord[] {
    return this.db
      .select(LEASE_COLUMNS)
      .from(sessionObservationCheckpoints)
      .orderBy(sessionObservationCheckpoints.sessionId)
      .all()
      .map((row) => this.mapRow(row))
      .filter((row): row is ObservationLeaseRecord => row !== null)
  }

  get(sessionId: SessionId): ObservationLeaseRecord | null {
    return this.read(sessionId)
  }

  /**
   * Fence a new observer before spawn/reattach is sent. Existing exact provider
   * identity is never replaced by a conflicting resume hint.
   */
  advanceGeneration(
    sessionId: SessionId,
    provider: ObservationLeaseRecord['provider'],
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    providerSessionId: string | null,
  ): ObservationLeaseRecord {
    return this.transact(() => {
      const updatedAt = new Date().toISOString()
      this.db
        .insert(sessionObservationCheckpoints)
        .values({
          sessionId,
          schemaVersion: 1,
          provider,
          providerSessionId,
          bindingVersion: 1,
          observationGeneration: 0,
          checkpointJson: null,
          updatedAt,
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
        .run()
      this.db
        .update(sessionObservationCheckpoints)
        .set({
          // Read-modify-write IN THE STATEMENT, not in the caller: the fence has
          // to advance atomically with respect to any other observer.
          observationGeneration: sql`${sessionObservationCheckpoints.observationGeneration} + 1`,
          providerSessionId: sql`COALESCE(${sessionObservationCheckpoints.providerSessionId}, ${providerSessionId})`,
          updatedAt,
        })
        .where(
          and(
            eq(sessionObservationCheckpoints.sessionId, sessionId),
            eq(sessionObservationCheckpoints.provider, provider),
          ),
        )
        .run()
      // A SPENT proof does not survive its observer's life. Consumption is the
      // last act of one hibernation; a fresh fence means the session is being
      // observed again, and `confirmTerminalCandidate` refuses to touch a
      // consumed row — leaving it would make a revived session permanently
      // ineligible with no path back short of a new user turn (POD-1879).
      // Unconsumed proofs are LEFT ALONE: an exact reattachment replay renews
      // them through `renewTerminalCandidate`, which is strictly fenced.
      const candidate = this.getTerminalCandidate(sessionId)
      if (candidate?.consumedAt) this.cancelTerminalCandidate(sessionId)
      const lease = this.read(sessionId)
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
  rebindExact(input: {
    sessionId: SessionId
    provider: ObservationLeaseRecord['provider']
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    providerSessionId: string | null
    bindingVersion: number
    observationGeneration: number
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    nextProviderSessionId: string
  }): ObservationRebindResult {
    return this.transact(() => {
      const current = this.read(input.sessionId)
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
      const receipt = this.readRebindReceipt(input.sessionId)
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
      const result = this.db
        .update(sessionObservationCheckpoints)
        .set({
          providerSessionId: input.nextProviderSessionId,
          bindingVersion,
          observationGeneration,
          checkpointJson: null,
          updatedAt,
        })
        .where(
          and(
            eq(sessionObservationCheckpoints.sessionId, input.sessionId),
            eq(sessionObservationCheckpoints.provider, input.provider),
            eq(sessionObservationCheckpoints.bindingVersion, input.bindingVersion),
            eq(sessionObservationCheckpoints.observationGeneration, input.observationGeneration),
            // THE FULL COMPARE-AND-SWAP, reproduced rather than simplified: the
            // `IS NULL AND ? IS NULL` arm is what lets a lease with no provider
            // session id be rebound at all, and `= NULL` would match no row.
            sql`(${sessionObservationCheckpoints.providerSessionId} = ${input.providerSessionId} OR (${sessionObservationCheckpoints.providerSessionId} IS NULL AND ${input.providerSessionId} IS NULL))`,
          ),
        )
        .run()
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
      this.db
        .insert(sessionObservationRebinds)
        .values(receiptRow)
        .onConflictDoUpdate({
          target: sessionObservationRebinds.sessionId,
          set: {
            provider: receiptRow.provider,
            fromProviderSessionId: receiptRow.fromProviderSessionId,
            fromBindingVersion: receiptRow.fromBindingVersion,
            fromObservationGeneration: receiptRow.fromObservationGeneration,
            toProviderSessionId: receiptRow.toProviderSessionId,
            resultingBindingVersion: receiptRow.resultingBindingVersion,
            resultingObservationGeneration: receiptRow.resultingObservationGeneration,
            updatedAt: receiptRow.updatedAt,
          },
        })
        .run()
      this.cancelTerminalCandidate(input.sessionId)
      const lease = this.read(input.sessionId)
      if (!lease) throw new Error(`missing rebound observation lease for ${input.sessionId}`)
      return { kind: 'accepted', disposition: 'advanced', lease }
    })
  }

  /** Persist only against the still-current lease; stale sockets cannot win. */
  save(checkpoint: SessionObservationCheckpointV1): void {
    const result = this.db
      .update(sessionObservationCheckpoints)
      .set({
        providerSessionId: sql`COALESCE(${sessionObservationCheckpoints.providerSessionId}, ${checkpoint.providerSessionId})`,
        checkpointJson: JSON.stringify(checkpoint),
        updatedAt: checkpoint.acceptedAt,
      })
      .where(
        and(
          eq(sessionObservationCheckpoints.sessionId, checkpoint.podiumSessionId),
          eq(sessionObservationCheckpoints.provider, checkpoint.provider),
          eq(sessionObservationCheckpoints.bindingVersion, checkpoint.bindingVersion),
          eq(
            sessionObservationCheckpoints.observationGeneration,
            checkpoint.lifecycleObservationGeneration,
          ),
          // NOT the same predicate as `rebindExact`'s: an UNSET provider session
          // id accepts any writer, where a set one must match. Keeping the two
          // spelled differently is the point.
          sql`(${sessionObservationCheckpoints.providerSessionId} IS NULL OR ${sessionObservationCheckpoints.providerSessionId} = ${checkpoint.providerSessionId})`,
        ),
      )
      .run()
    if (Number(result.changes) !== 1) {
      throw new Error(`observation checkpoint lease changed for ${checkpoint.podiumSessionId}`)
    }
  }

  getTerminalCandidate(sessionId: SessionId): TerminalCandidateRecord | null {
    const row = this.db
      .select({
        proofJson: sessionTerminalCandidates.proofJson,
        confirmedAt: sessionTerminalCandidates.confirmedAt,
        consumedAt: sessionTerminalCandidates.consumedAt,
        updatedAt: sessionTerminalCandidates.updatedAt,
      })
      .from(sessionTerminalCandidates)
      .where(eq(sessionTerminalCandidates.sessionId, sessionId))
      .get()
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
  recordTerminalCandidate(facts: TerminalCandidateFacts, at: string): void {
    const proof = {
      facts,
      firstLivePollSequence: 0,
      lastLivePollSequence: 0,
    }
    this.upsertProof(facts.sessionId, proof, at)
  }

  /**
   * Write a fresh proof, CLEARING both stamps — the shape `record` and `arm`
   * share. It was two identical statements before the conversion; they are one
   * here because a difference between them would have been a defect either way.
   */
  private upsertProof(sessionId: SessionId, proof: unknown, at: string): void {
    const proofJson = JSON.stringify(proof)
    this.db
      .insert(sessionTerminalCandidates)
      .values({
        sessionId,
        proofJson,
        confirmedAt: null,
        consumedAt: null,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: sessionTerminalCandidates.sessionId,
        set: { proofJson, confirmedAt: null, consumedAt: null, updatedAt: at },
      })
      .run()
  }

  /** Arm pass one at this observer sequence, discarding whatever was there. */
  private armTerminalCandidate(
    facts: TerminalCandidateFacts,
    livePollSequence: number,
    at: string,
  ): void {
    const proof = {
      facts,
      firstLivePollSequence: livePollSequence,
      lastLivePollSequence: livePollSequence,
    }
    this.upsertProof(facts.sessionId, proof, at)
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
  confirmTerminalCandidate(
    facts: TerminalCandidateFacts,
    livePollSequence: number,
    at: string,
  ): 'recorded' | 'confirmed' | 'unchanged' | 'rehabilitated' {
    return this.transact(() => {
      const current = this.getTerminalCandidate(facts.sessionId)
      if (current?.consumedAt) {
        if (facts.observerGeneration <= current.facts.observerGeneration) return 'unchanged'
        this.armTerminalCandidate(facts, livePollSequence, at)
        return 'rehabilitated'
      }
      if (!current || !sameFacts(current.facts, facts)) {
        this.armTerminalCandidate(facts, livePollSequence, at)
        return 'recorded'
      }
      if (current.confirmedAt) return 'unchanged'
      if (livePollSequence < current.firstLivePollSequence) {
        // The observer's counter only ever rises within one observer life, so a
        // lower sequence is a RESTARTED counter, not a replayed receipt. Left
        // alone it can never clear `lastLivePollSequence` again.
        this.armTerminalCandidate(facts, livePollSequence, at)
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
      this.db
        .update(sessionTerminalCandidates)
        .set({
          proofJson: JSON.stringify(proof),
          // COALESCE, so a second confirmation keeps the FIRST instant.
          confirmedAt: sql`COALESCE(${sessionTerminalCandidates.confirmedAt}, ${confirmed ? at : null})`,
          updatedAt: at,
        })
        .where(
          and(
            eq(sessionTerminalCandidates.sessionId, facts.sessionId),
            isNull(sessionTerminalCandidates.consumedAt),
          ),
        )
        .run()
      return confirmed ? 'confirmed' : 'recorded'
    })
  }

  /**
   * Translate one confirmed proof across an exact, freshly fenced reattachment.
   * The caller supplies the current facts only after the daemon has replayed the
   * durable checkpoint under the new observer generation. Generation and PTY
   * repaint counters may advance; every causal/work fact must remain identical.
   */
  renewTerminalCandidate(facts: TerminalCandidateFacts, at: string): boolean {
    return this.transact(() => {
      const current = this.getTerminalCandidate(facts.sessionId)
      if (
        !current?.confirmedAt ||
        current.consumedAt ||
        !sameFactsAcrossReattachment(current.facts, facts)
      )
        return false
      const lease = this.read(facts.sessionId)
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
      const result = this.db
        .update(sessionTerminalCandidates)
        .set({ proofJson: JSON.stringify(proof), updatedAt: at })
        .where(
          and(
            eq(sessionTerminalCandidates.sessionId, facts.sessionId),
            // The PREVIOUS proof text is part of the guard: a renewal only lands
            // on the exact row it read, so a concurrent write cannot be
            // overwritten by a translation of a proof that is no longer there.
            eq(sessionTerminalCandidates.proofJson, previousProof),
            sql`${sessionTerminalCandidates.confirmedAt} IS NOT NULL`,
            isNull(sessionTerminalCandidates.consumedAt),
          ),
        )
        .run()
      return Number(result.changes) === 1
    })
  }

  /** Final apply-time compare-and-consume; callers run this in the session-row transaction. */
  consumeTerminalCandidate(facts: TerminalCandidateFacts, at: string): boolean {
    const current = this.getTerminalCandidate(facts.sessionId)
    if (!current?.confirmedAt || current.consumedAt || !sameFacts(current.facts, facts))
      return false
    const lease = this.read(facts.sessionId)
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
    const result = this.db
      .update(sessionTerminalCandidates)
      .set({ consumedAt: at, updatedAt: at })
      .where(
        and(
          eq(sessionTerminalCandidates.sessionId, facts.sessionId),
          sql`${sessionTerminalCandidates.confirmedAt} IS NOT NULL`,
          isNull(sessionTerminalCandidates.consumedAt),
        ),
      )
      .run()
    return Number(result.changes) === 1
  }

  cancelTerminalCandidate(sessionId: SessionId): void {
    this.db
      .delete(sessionTerminalCandidates)
      .where(eq(sessionTerminalCandidates.sessionId, sessionId))
      .run()
  }

  purge(sessionId: SessionId): void {
    this.db
      .delete(sessionObservationCheckpoints)
      .where(eq(sessionObservationCheckpoints.sessionId, sessionId))
      .run()
  }
}
