/**
 * The Replica role of the sync kernel — a pure state machine over injected ports
 * (ADR 2 as amended by ADR 2 Amendment 1; storage port per ADR 6 D3).
 *
 * DELTA-FIRST. Steady state is "apply certified frames in seq order". Bootstrap is
 * the RECOVERY case that every rung of the D7 ladder terminates at (ADR 2 D6/D7) —
 * which is exactly what keeps it the most-exercised path in the system rather than
 * a rarely-tested emergency one.
 *
 * THE INVARIANT THIS COMPONENT EXISTS TO HOLD: **a replica never arbitrates.**
 * It applies an ordering somebody else decided. Concretely, in this file:
 *  - `revision` is stored and echoed, never compared to decide a winner. Feed order
 *    is the only order. A same-revision upsert is APPLIED, not dropped — that is
 *    literally the re-admission path (Amendment 1 D14.2), and a "skip duplicate
 *    revisions" optimisation would silently break re-sharing.
 *  - No id is ever invented here. No local guess is promoted to fact.
 *  - **No visibility is ever evaluated.** There is no principal, grant or owner in
 *    this file. `evict` is applied because the Authority said so; the Replica never
 *    computes who may see what, never filters its own view, and never infers a
 *    share (Amendment 1 D12.7). If this file ever needs to ask "may this principal
 *    see X", the design has drifted.
 *
 * D13 IS FOLLOWED LITERALLY: accept iff `fromSeq === cursor`, otherwise rung 1.
 * An earlier revision of this file also absorbed re-delivered and partially
 * overlapping frames through two locally-derived transitions. Removed after
 * review: D13.1 normatively guarantees frames for one connection are contiguous
 * and non-overlapping, so those are protocol violations rather than cases to
 * tolerate, and tolerating them made the acceptance rule WEAKER than the one the
 * amendment strengthened. On a contract shared with POD-1077 and POD-308, a
 * locally documented fork is not good enough.
 *
 * ORDER IS THE CORRECTNESS PROPERTY, including inside one frame. Changes go to
 * the store as ONE ordered operation list (see `CacheOperation`), never grouped
 * by op kind — grouping applied every upsert before every removal, so
 * `remove(seq 1)` then `upsert(seq 2)` for one entity left the entity absent.
 */

import type { OptimisticOverlayPort } from './overlay'
import {
  type AuthorityReadPort,
  type CacheMutation,
  type CacheOperation,
  type KnownKindValidatorPort,
  type ReplicaCacheStore,
  ReplicaStoreCorruptError,
} from './ports'
import { transitionRow } from './transition-table'
import type {
  BootstrapChunk,
  ChangeEnvelope,
  Cursor,
  DeltaFrame,
  EntityRecord,
  ExitKind,
  HealRung,
  Posture,
  RebootstrapCause,
  ReplicaEvent,
  ReplicaStats,
  ServerFrame,
} from './types'

export interface ReplicaOptions {
  readonly store: ReplicaCacheStore
  readonly authority: AuthorityReadPort
  /** Optional until POD-372/POD-351 land real reducers. Absent ⇒ the view is the base. */
  readonly overlay?: OptimisticOverlayPort
  /**
   * ADR 2 D7 rung 3's known-kind check. Absent ⇒ no kind is known ⇒ everything is
   * parsed leniently (D4), which is the correct posture for a kernel that has not
   * been told any schemas. POD-308/POD-351 supply the real one.
   */
  readonly validator?: KnownKindValidatorPort
  readonly onEvent?: (event: ReplicaEvent) => void
  /** ADR 2 D6.5 — a failed bootstrap RESTARTS (resumable bootstrap is deferred). */
  readonly maxBootstrapAttempts?: number
}

/** What a single input did, including the transition-table row it took. */
export interface TransitionOutcome {
  readonly rowId: string
  readonly posture: Posture
  readonly cursor: Cursor | null
  readonly rung: HealRung | null
}

const entityKey = (entity: string, entityId: string): string => `${entity}\u0000${entityId}`

export class Replica {
  private readonly store: ReplicaCacheStore
  private readonly authority: AuthorityReadPort
  private readonly overlayPort: OptimisticOverlayPort | undefined
  private readonly validator: KnownKindValidatorPort | undefined
  private readonly emit: (event: ReplicaEvent) => void
  private readonly maxBootstrapAttempts: number

  private state: Posture = 'cold'
  private cursorValue: Cursor | null = null
  /**
   * Frames held while a bootstrap walk or a heal is in flight. The rule is stated
   * over FRAMES, never over ops, so watermarks and evicts are covered by
   * construction rather than by remembering to list them (D6.3 / D15.2).
   */
  private buffer: DeltaFrame[] = []
  /** How each entity left the view. The model-level remove-vs-evict distinction (D14.5). */
  private readonly exits = new Map<string, ExitKind>()
  /** Set while a bootstrap walk is in flight; bumped to abandon a superseded walk. */
  private walkGeneration = 0
  private inflight: Promise<void> = Promise.resolve()
  private pendingTransition = false
  /**
   * Every transition-table row this replica has taken, in order. Not telemetry:
   * it is how `transition-table.test.ts` proves the ADR's table is EXERCISED
   * rather than merely transcribed — including the rows that only fire deep
   * inside an async heal or bootstrap walk and never surface as a return value.
   */
  readonly trace: string[] = []
  /**
   * The same rows with the postures actually observed around them. The bare
   * `trace` proved a row IDENTIFIER was reached; this proves the row's declared
   * `from`/`to` match what the machine really did, which is what caught the table
   * claiming D6-BUFFER lands in `bootstrapping` when it fires during a heal.
   */
  readonly transitions: { rowId: string; from: Posture; to: Posture }[] = []

  private counters = {
    heals: 0,
    bootstraps: 0,
    framesApplied: 0,
    watermarksApplied: 0,
    pendingGap: false,
  }

  constructor(options: ReplicaOptions) {
    this.store = options.store
    this.authority = options.authority
    this.overlayPort = options.overlay
    this.validator = options.validator
    this.emit = options.onEvent ?? (() => {})
    this.maxBootstrapAttempts = options.maxBootstrapAttempts ?? 3
    this.cursorValue = this.readCursorSafely()
    if (this.cursorValue !== null) this.state = 'stale'
  }

  // ─── Observation ──────────────────────────────────────────────────────────

  get posture(): Posture {
    return this.state
  }

  get cursor(): Cursor | null {
    return this.cursorValue
  }

  /** True while the replica is showing data it cannot currently confirm (D7 stale-visible). */
  get isStale(): boolean {
    return this.state === 'stale'
  }

  stats(): ReplicaStats {
    return {
      bufferedFrames: this.buffer.length,
      bufferedChanges: this.buffer.reduce((n, f) => n + f.changes.length, 0),
      pendingGaps: this.counters.pendingGap ? 1 : 0,
      heals: this.counters.heals,
      bootstraps: this.counters.bootstraps,
      framesApplied: this.counters.framesApplied,
      watermarksApplied: this.counters.watermarksApplied,
      entityCount: this.store.readEntities().length,
    }
  }

  /** How this entity left the view, if it did. `undefined` ⇒ it is present, or was never held. */
  exitKind(entity: string, entityId: string): ExitKind | undefined {
    return this.exits.get(entityKey(entity, entityId))
  }

  /**
   * The read model: authoritative base with the optimistic overlay applied on top.
   * The overlay is DERIVED here and never persisted (ADR 4 D7).
   */
  view(entity: string, entityId: string): unknown {
    const base = this.store.read(entity, entityId)
    if (this.overlayPort === undefined) return base?.value
    let value: unknown = base?.value
    for (const pending of this.overlayPort.pending(entity, entityId)) {
      value = this.overlayPort.reduce(value, pending.command)
    }
    return value
  }

  /** The installed slice, base only. Conformance and hydrate use this. */
  entities(): readonly EntityRecord[] {
    return this.store.readEntities()
  }

  /** Resolves once every input accepted so far has fully settled (heals and walks included). */
  async settled(): Promise<void> {
    this.sealTransitions()
    // A heal can start a bootstrap, which can start a heal. Drain until quiet.
    for (let i = 0; i < 50; i += 1) {
      const before = this.inflight
      await before
      if (this.inflight === before) return
    }
    throw new Error('replica did not settle: the ladder is not resolving downward')
  }

  // ─── Inputs ───────────────────────────────────────────────────────────────

  /** Come online. From `cold` this bootstraps; from `stale` it RESUMES from the cursor. */
  connect(): TransitionOutcome {
    const from = this.state
    if (this.cursorValue === null) {
      this.startRebootstrap('cold-start')
      return this.outcome('D7-2-COLD', from)
    }
    this.startHeal()
    return this.outcome('D7-1-RESUME', from)
  }

  /** Go offline. The last-known slice stays VISIBLE, marked stale (D7). Never blank. */
  disconnect(): TransitionOutcome {
    // Abandon any walk in flight: its staging is discarded, never half-installed.
    this.walkGeneration += 1
    this.buffer = []
    this.counters.pendingGap = false
    if (this.cursorValue === null) return this.transitionTo('cold', 'D7-DISCONNECT-COLD')
    return this.transitionTo('stale', 'D7-STALE-VISIBLE')
  }

  /** ADR 2 D4 / D7 rung 6 — the local store layout moved; discard rather than migrate. */
  replicaSchemaChanged(): TransitionOutcome {
    const from = this.state
    this.store.discardCache()
    this.cursorValue = null
    this.startRebootstrap('schema-version')
    return this.outcome('D7-6-SCHEMA', from)
  }

  /** The one entry point for everything the authority pushes. */
  receive(frame: ServerFrame): TransitionOutcome {
    const from = this.state
    try {
      return this.route(frame, from)
    } catch (error) {
      if (error instanceof ReplicaStoreCorruptError) return this.onCorruption()
      throw error
    }
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  private route(frame: ServerFrame, from: Posture): TransitionOutcome {
    // Control frames act immediately and are never buffered: both resolve
    // strictly DOWNWARD, so deferring them could only delay the terminal path.
    if (frame.kind === 'rescope') {
      // Amendment 1 D14.4 — always legal, from any posture, on the SAME path as
      // every other rung. Cause is recorded as authz, distinguishable in
      // telemetry from backpressure.
      this.startRebootstrap('rescope')
      return this.outcome('D14-RESCOPE', from)
    }
    if (frame.kind === 'resync-required') {
      this.startRebootstrap('resync-required')
      return this.outcome('D7-2-RESYNC', from)
    }

    // ADR 2 D1 / D7 rung 4 — equality only, and checked BEFORE the buffering
    // branch. It used to sit after it, so a mismatched frame arriving during a
    // heal or a walk was quietly buffered (D6-BUFFER) instead of taking the
    // declared D7-4-EPOCH transition; the mismatch was then noticed much later,
    // in drainBuffer, or silently skipped at install. Rung 4 says discard and
    // re-bootstrap, and it must fire wherever a cursor exists to compare against.
    if (
      this.cursorValue !== null &&
      (frame.feedId !== this.cursorValue.feedId || frame.epoch !== this.cursorValue.epoch)
    ) {
      this.startRebootstrap('epoch-mismatch')
      return this.outcome('D7-4-EPOCH', from)
    }

    if (this.state === 'bootstrapping' || this.state === 'healing') {
      // Validate BEFORE buffering. Buffering first meant a malformed frame
      // received during a heal or a walk was applied later without ever passing
      // rung 3 — the cursor advanced over a corrupt payload. Rung 3 must be
      // unavoidable on EVERY route into the store, not only the live one.
      if (this.rejects(frame) !== null) {
        this.startRebootstrap('malformed')
        return this.outcome('D7-3-MALFORMED', from)
      }
      this.buffer.push(frame)
      return this.outcome('D6-BUFFER', from)
    }

    if (this.state === 'cold' || this.cursorValue === null) {
      // Nothing to apply a delta onto.
      this.startRebootstrap('cold-start')
      return this.outcome('D7-2-COLD', from)
    }

    if (this.rejects(frame) !== null) {
      this.startRebootstrap('malformed')
      return this.outcome('D7-3-MALFORMED', from)
    }

    if (this.state === 'stale') {
      // The link came back underneath us. Frames were missed while offline, so
      // heal from the cursor rather than applying blind.
      this.buffer.push(frame)
      this.startHeal()
      return this.outcome('D7-1-FRAME-WHILE-STALE', from)
    }

    return this.applyCertified(frame, from)
  }

  /**
   * Rung 0, literally as Amendment 1 D13 states it: **accept iff
   * `fromSeq === cursor`. Otherwise it is a gap.**
   *
   * An earlier version of this file also accepted a wholly re-delivered frame
   * (ignoring it) and a partially overlapping one (truncating to the uncovered
   * tail). Both are removed. D13.1 normatively guarantees that frames for one
   * connection are "strictly ordered, contiguous and NON-OVERLAPPING", so those
   * cases are protocol violations rather than situations to be tolerated — and
   * tolerating them made the rule WEAKER than the one it replaced, when the
   * amendment's whole point is that an explicit lower bound is STRONGER (it also
   * catches a frame that vanished between two others). A replica that quietly
   * absorbs an overlapping frame removes the only check that would have caught an
   * authority emitting them, on a contract shared with POD-1077 and POD-308.
   *
   * The cost of strictness is one heal round trip if a transport ever does
   * re-deliver, which resolves and terminates — it is not the endless-heal shape
   * D13 exists to prevent, because the heal advances the cursor.
   */
  private applyCertified(frame: DeltaFrame, from: Posture): TransitionOutcome {
    const cursor = this.cursorValue as Cursor

    if (frame.fromSeq !== cursor.seq) {
      // Do NOT apply. Applying would make the cursor certify data we never
      // received, which is a permanent lie rather than a lost update.
      this.buffer.push(frame)
      this.counters.pendingGap = true
      this.startHeal()
      return this.outcome('D7-1-GAP', from)
    }

    return this.outcome(this.commitChanges(frame.changes, { ...cursor, seq: frame.seq }), from)
  }

  /**
   * ONE transaction for the changes and the cursor (ADR 2 D10 / ADR 6 D4.1), so
   * the cursor is never ahead of the data it claims. Returns the transition row
   * that best describes what the frame carried.
   */
  private commitChanges(changes: readonly ChangeEnvelope[], nextCursor: Cursor): string {
    this.store.applyAtomic(toMutation(changes, nextCursor))
    this.cursorValue = nextCursor
    this.counters.pendingGap = false

    return this.emitApplied(changes, nextCursor)
  }

  /**
   * The ONE post-commit emission path, shared by live application, heal
   * application and post-install replay of buffered frames.
   *
   * It is one function on purpose. It used to be two — `commitChanges` and a
   * separate `replayEmissions` for the bootstrap path — and they drifted: only
   * the first retired overlay entries, and only for upserts, so a tombstone or an
   * eviction carrying provenance never retired the command that caused it, and
   * nothing applied through a bootstrap retired anything at all. Two emission
   * paths for one concept is how a contract in a docstring stops being true.
   *
   * Emission happens strictly AFTER the commit, so no observer can see
   * uncommitted state.
   */
  private emitApplied(changes: readonly ChangeEnvelope[], cursor: Cursor): string {
    let sawEvict = false
    let sawRemove = false
    let sawReadmit = false

    // Project each change SEQUENTIALLY, from its own envelope, against an exit
    // state that evolves as we walk the frame. Two earlier shortcuts both broke
    // feed order in the PUBLIC projection while the cache had it right:
    //  - re-admission was precomputed from the pre-frame exit map, so
    //    evict(seq 1) + same-revision upsert(seq 2) in ONE frame emitted
    //    readmitted:false and a client would render a re-share as a creation
    //    (Amendment 1 D14.2);
    //  - each upsert's record was read back from the already-final store, so
    //    upsert-then-remove in one frame emitted NO upserted event at all, and
    //    two upserts of one entity both reported the last value.
    // The envelope is the truth about what happened at that seq; the store is
    // only the truth about where the frame ENDED.
    for (const change of changes) {
      const key = entityKey(change.entity, change.entityId)
      if (change.op === 'upsert') {
        const readmitted = this.exits.get(key) === 'evicted'
        sawReadmit ||= readmitted
        this.exits.delete(key)
        this.emit({ type: 'upserted', record: recordOf(change), readmitted })
      } else if (change.op === 'remove') {
        sawRemove = true
        this.exits.set(key, 'removed')
        this.emit({ type: 'removed', entity: change.entity, entityId: change.entityId })
      } else {
        // D14.1 — dropped from cache and from derived views, and that is ALL.
        // No domain "deleted" event, no tombstone: an entity you can no longer
        // see has not stopped existing.
        sawEvict = true
        this.exits.set(key, 'evicted')
        this.emit({ type: 'evicted', entity: change.entity, entityId: change.entityId })
      }

      // ADR 2 D8 — retirement is EXACT, by envelope provenance, for EVERY op that
      // carries it. A delete I authored must retire its outbox entry exactly as an
      // edit I authored does; matching on values instead would be arbitration.
      if (change.causationId !== undefined || change.mutationId !== undefined) {
        this.overlayPort?.retire({
          entity: change.entity,
          entityId: change.entityId,
          causationId: change.causationId,
          mutationId: change.mutationId,
        })
      }
    }

    const watermarkOnly = changes.length === 0
    if (watermarkOnly) this.counters.watermarksApplied += 1
    this.counters.framesApplied += 1
    this.emit({ type: 'cursor', cursor, watermarkOnly })

    if (watermarkOnly) return 'D13-WATERMARK'
    if (sawEvict) return 'D14-EVICT'
    if (sawRemove) return 'D5-REMOVE'
    if (sawReadmit) return 'D14-READMIT'
    return 'D7-0-APPLY'
  }

  // ─── Rung 1: heal ─────────────────────────────────────────────────────────

  private startHeal(): void {
    this.counters.heals += 1
    this.setPosture('healing')
    this.emit({ type: 'heal', rung: 1, cause: 'gap' })
    this.run(async () => {
      const cursor = this.cursorValue
      if (cursor === null) {
        this.startRebootstrap('cold-start')
        return
      }
      let reply: Awaited<ReturnType<AuthorityReadPort['changesSince']>>
      try {
        reply = await this.authority.changesSince(cursor)
      } catch {
        // The link is gone. Keep the slice visible; connect() will retry.
        if (this.state === 'healing') this.setPosture('stale')
        return
      }
      if (this.state !== 'healing') return // superseded by a rescope/disconnect

      if (reply.kind === 'bootstrap-required') {
        this.note('D7-2-COMPACTED')
        this.startRebootstrap('compacted')
        return
      }
      if (reply.feedId !== cursor.feedId || reply.epoch !== cursor.epoch) {
        this.note('D7-4-EPOCH')
        this.startRebootstrap('epoch-mismatch')
        return
      }
      // Rung 3, not a retry: re-asking the question that just failed is the
      // infinite loop D7 forbids.
      // this.rejects(), not validateFrame(): the authority-pull route must clear
      // the SAME rung-3 bar as the pushed route, injected known-kind check
      // included. Using the shape-only check here let a corrupt known-kind row
      // in through the heal reply.
      if (this.rejects(reply) !== null || reply.fromSeq !== cursor.seq) {
        this.note('D7-3-REPLY-MALFORMED')
        this.startRebootstrap('malformed')
        return
      }

      this.note(this.commitChanges(reply.changes, { ...cursor, seq: reply.seq }))
      this.note('D7-1-HEALED')
      this.setPosture('live')
      this.drainBuffer()
    })
  }

  /**
   * Apply buffered frames while they chain exactly; the first that does not,
   * heals again.
   *
   * A frame wholly at or below the cursor is DROPPED, not applied and not healed:
   * our own cursor already certifies that range, so there is nothing to learn
   * from it and nothing to lose by discarding it. That is not the acceptance of
   * an overlapping frame — nothing from it reaches the store.
   */
  private drainBuffer(): void {
    const buffered = this.buffer
    this.buffer = []
    for (let i = 0; i < buffered.length; i += 1) {
      const frame = buffered[i] as DeltaFrame
      const cursor = this.cursorValue as Cursor
      if (frame.feedId !== cursor.feedId || frame.epoch !== cursor.epoch) {
        this.startRebootstrap('epoch-mismatch')
        return
      }
      if (frame.seq <= cursor.seq) {
        this.note('D6-BUFFER-COVERED')
        continue
      }
      if (frame.fromSeq !== cursor.seq) {
        this.buffer = buffered.slice(i)
        this.counters.pendingGap = true
        this.startHeal()
        return
      }
      this.note(this.commitChanges(frame.changes, { ...cursor, seq: frame.seq }))
    }
  }

  // ─── Rungs 2-6: the ONE terminal path ─────────────────────────────────────

  /**
   * Every rung ends here. That is the design, and it is also the enforcement:
   * "discard the cache, re-bootstrap, KEEP THE OUTBOX" is a property of this one
   * function, not a rule repeated at six call sites where one of them forgets.
   *
   * The outbox is not discarded because it CANNOT be reached from here — it is
   * not on `ReplicaCacheStore` at all (see ports.ts). Under private-by-default a
   * `rescope` fires whenever somebody's shares change, so this is a normal-path
   * event and a drop-the-outbox bug would be reachable by a colleague clicking
   * "share" (ADR 2 D7 + Amendment 1 D14.4).
   *
   * The cache discard happens at the ATOMIC SWAP (`installSnapshot`), not up
   * front: rungs 2-6 must never blank the UI before the replacement state is
   * installed (D7 stale-visible + D6.4).
   */
  private startRebootstrap(cause: RebootstrapCause): void {
    // Bump first, then read: a superseded walk notices the mismatch and abandons
    // its staging rather than installing a slice the ladder has moved past.
    this.walkGeneration += 1
    const generation = this.walkGeneration
    this.counters.bootstraps += 1
    this.counters.pendingGap = false
    this.setPosture('bootstrapping')
    this.emit({ type: 'heal', rung: rungFor(cause), cause })
    this.run(() => this.walk(cause, generation))
  }

  private async walk(cause: RebootstrapCause, generation: number): Promise<void> {
    let lastError = 'unknown'
    for (let attempt = 1; attempt <= this.maxBootstrapAttempts; attempt += 1) {
      if (generation !== this.walkGeneration) return // superseded; staging discarded
      try {
        const installed = await this.attemptWalk(cause, generation)
        if (installed || generation !== this.walkGeneration) return
        lastError = 'stream ended before the last chunk'
        this.note('D6-RESTART')
      } catch (error) {
        if (error instanceof ReplicaStoreCorruptError) {
          this.onCorruption()
          return
        }
        lastError = error instanceof Error ? error.message : String(error)
        this.note('D6-RESTART')
      }
      // D6-RESTART: staging is local to attemptWalk, so it is discarded by
      // leaving it. Bootstrap is restartable, not resumable, in Phase 2.
    }
    if (generation !== this.walkGeneration) return
    this.emit({
      type: 'bootstrap-failed',
      cause,
      attempts: this.maxBootstrapAttempts,
      error: lastError,
    })
    // D6-EXHAUSTED: keep serving whatever is installed, marked stale. Never blank.
    this.note('D6-EXHAUSTED')
    this.setPosture(this.cursorValue === null ? 'cold' : 'stale')
  }

  /** One attempt. Returns true iff the slice was installed. */
  private async attemptWalk(cause: RebootstrapCause, generation: number): Promise<boolean> {
    const staging = new Map<string, EntityRecord>()
    let head: { feedId: string; epoch: string; snapshotSeq: number } | null = null
    let sawLast = false

    for await (const chunk of this.authority.bootstrap()) {
      if (generation !== this.walkGeneration) return false
      if (head === null) {
        head = { feedId: chunk.feedId, epoch: chunk.epoch, snapshotSeq: chunk.snapshotSeq }
      } else if (
        chunk.feedId !== head.feedId ||
        chunk.epoch !== head.epoch ||
        chunk.snapshotSeq !== head.snapshotSeq
      ) {
        throw new Error('bootstrap chunks disagree about the snapshot point')
      }
      for (const change of chunk.changes) {
        // D6 — a snapshot is POSITIVE STATE. A remove/evict inside it is not a
        // smaller snapshot, it is a malformed one.
        if (change.op !== 'upsert' || change.payload === undefined) {
          throw new Error(`bootstrap chunk carried a non-upsert row: ${change.op}`)
        }
        if (change.seq > head.snapshotSeq) {
          throw new Error('bootstrap chunk carried a row above the snapshot point')
        }
        // The third ingress route. A snapshot is the RECOVERY path, so a corrupt
        // known-kind row here is the worst place to accept one: it installs as
        // authoritative truth and the cursor advances over it. Unknown kinds stay
        // lenient (D4) exactly as on the other two routes.
        if (this.validator?.knows(change.entity) === true) {
          const reason = this.validator.validate(change)
          if (reason !== null) throw new Error(`bootstrap chunk failed validation: ${reason}`)
        }
        staging.set(entityKey(change.entity, change.entityId), {
          entity: change.entity,
          entityId: change.entityId,
          value: change.payload,
          revision: change.revision,
          provenance: {
            seq: change.seq,
            originId: change.originId,
            causationId: change.causationId,
            mutationId: change.mutationId,
          },
        })
      }
      if (chunk.last) {
        sawLast = true
        break
      }
    }

    if (head === null || !sawLast) return false
    if (generation !== this.walkGeneration) return false

    this.install(cause, head, staging)
    return true
  }

  private install(
    cause: RebootstrapCause,
    head: { feedId: string; epoch: string; snapshotSeq: number },
    staging: Map<string, EntityRecord>,
  ): void {
    const snapshotCursor: Cursor = {
      feedId: head.feedId,
      epoch: head.epoch,
      seq: head.snapshotSeq,
    }
    const buffered = this.buffer
    this.buffer = []

    // Fold the buffered frames against the snapshot point. No truncation: a frame
    // is either dropped (wholly covered by the snapshot) or applied whole from an
    // exact chain, and anything else heals. Truncating a straddling frame would
    // mean applying a fragment of a certified range, which is precisely the
    // acceptance D13 forbids — and it would have to be re-validated to be safe,
    // so the simple rule is also the cheap one.
    const mutations: CacheMutation[] = []
    const emissions: { changes: readonly ChangeEnvelope[]; cursor: Cursor }[] = []
    let running = snapshotCursor
    let gapAt = -1
    for (let i = 0; i < buffered.length; i += 1) {
      const frame = buffered[i] as DeltaFrame
      if (frame.feedId !== head.feedId || frame.epoch !== head.epoch) continue // not ours (D7-4)
      if (frame.seq <= running.seq) {
        this.note('D6-BUFFER-COVERED')
        continue
      }
      if (frame.fromSeq !== running.seq) {
        gapAt = i
        break
      }
      const next: Cursor = { ...running, seq: frame.seq }
      mutations.push(toMutation(frame.changes, next))
      emissions.push({ changes: frame.changes, cursor: next })
      running = next
    }

    const rows = [...staging.values()]
    // THE ATOMIC SWAP. This replaces the cache (that is the D7 "discard") and
    // applies the buffered frames and the cursor in the SAME transaction.
    this.store.installSnapshot(rows, snapshotCursor, mutations)
    this.note('D6-INSTALL')
    this.cursorValue = running
    this.exits.clear()

    for (const row of rows) this.emit({ type: 'upserted', record: row, readmitted: false })
    this.emit({
      type: 'bootstrap-installed',
      cause,
      snapshotSeq: head.snapshotSeq,
      entityCount: rows.length,
      bufferedFramesApplied: mutations.length,
    })
    // Same emission/retirement semantics as the live and heal paths — one
    // function, so a change applied through a bootstrap retires its outbox entry
    // exactly as a change applied live does.
    for (const emission of emissions) {
      this.emitApplied(emission.changes, emission.cursor)
    }

    this.setPosture('live')
    if (gapAt >= 0) {
      // DISCARD the unchainable remainder rather than re-buffering it. Keeping it
      // is an infinite ladder: the frame demands a fromSeq the fresh snapshot
      // cannot satisfy, so install -> heal -> (authority says re-bootstrap) ->
      // install -> the same frame, forever. D7 requires every failure to resolve
      // strictly DOWNWARD and terminate, and a bootstrap has just delivered
      // authoritative truth — a stale frame buffered around the walk is not
      // something to hold the ladder open for. One heal catches up, resolved
      // against the authority instead of against our own stale buffer.
      // Recorded against 'bootstrapping': the install transaction has already
      // committed (which is why the posture reads live), but this row describes
      // what the WALK found in its leftover buffer.
      this.note('D6-INSTALL-GAP', 'bootstrapping')
      this.buffer = []
      this.counters.pendingGap = true
      this.startHeal()
    }
  }

  // ─── Rung 5 ───────────────────────────────────────────────────────────────

  private onCorruption(): TransitionOutcome {
    const from = this.state
    // The store is unreadable, so the cache must go explicitly rather than at
    // the swap. The outbox lives behind a port this method cannot name; if it
    // is ALSO lost, that loss is surfaced by its own store, loudly (D7).
    try {
      this.store.discardCache()
    } catch {
      // A store too broken to clear is still a store we re-bootstrap over.
    }
    this.cursorValue = null
    this.buffer = []
    this.exits.clear()
    this.startRebootstrap('local-corruption')
    return this.outcome('D7-5-CORRUPT', from)
  }

  /**
   * Everything rung 3 rejects, in one place so no route into the store can skip
   * it: generic frame/range shape, plus the injected known-kind check.
   *
   * The asymmetry is D4's and it is deliberate — an UNKNOWN entity kind is
   * accepted with an opaque value and the cursor advances past it, because
   * quarantining it would create an invisible permanent gap that heals to the same
   * rows forever. A KNOWN kind that fails its schema, or whose embedded id
   * disagrees with the envelope, is a rung-3 rejection.
   */
  private rejects(frame: DeltaFrame): string | null {
    const shape = validateFrame(frame)
    if (shape !== null) return shape
    const validator = this.validator
    if (validator === undefined) return null
    for (const change of frame.changes) {
      if (!validator.knows(change.entity)) continue
      const reason = validator.validate(change)
      if (reason !== null) return reason
    }
    return null
  }

  // ─── Plumbing ─────────────────────────────────────────────────────────────

  private readCursorSafely(): Cursor | null {
    try {
      return this.store.readCursor()
    } catch (error) {
      if (error instanceof ReplicaStoreCorruptError) return null
      throw error
    }
  }

  private run(task: () => Promise<void>): void {
    this.inflight = this.inflight.then(task).catch((error) => {
      if (error instanceof ReplicaStoreCorruptError) {
        this.onCorruption()
        return
      }
      throw error
    })
  }

  private setPosture(next: Posture): void {
    if (next === this.state) return
    const previous = this.state
    this.state = next
    // A row's `to` is the posture its effect settles on, so seal here rather than
    // making callers remember. A row that changes no posture keeps to === from,
    // which is also correct.
    this.sealTransitions()
    this.emit({ type: 'posture', posture: next, previous })
  }

  private transitionTo(next: Posture, rowId: string): TransitionOutcome {
    const from = this.state
    this.setPosture(next)
    return this.outcome(rowId, from)
  }

  private note(rowId: string, from: Posture = this.state): string {
    transitionRow(rowId) // fails loudly on a row that is not in the ADR's table
    // Seal the previous row's `to` before opening a new one: by the time the next
    // row fires, the previous one's effect has finished.
    this.sealTransitions()
    this.trace.push(rowId)
    // `from` is the posture BEFORE this row's effect ran. Several effects
    // (startHeal, startRebootstrap) change posture synchronously, so reading
    // this.state here would record the DESTINATION as the source and make the
    // table look wrong when it was right.
    this.transitions.push({ rowId, from, to: this.state })
    this.pendingTransition = true
    return rowId
  }

  /** Stamp the observed post-state onto any row whose effect has now completed. */
  private sealTransitions(): void {
    if (!this.pendingTransition) return
    const last = this.transitions.at(-1)
    if (last !== undefined) last.to = this.state
    this.pendingTransition = false
  }

  private outcome(rowId: string, from: Posture = this.state): TransitionOutcome {
    this.note(rowId, from)
    this.sealTransitions()
    return {
      rowId,
      posture: this.state,
      cursor: this.cursorValue,
      rung: transitionRow(rowId).rung,
    }
  }
}

/** The record a change describes, built from the ENVELOPE rather than read back. */
function recordOf(change: ChangeEnvelope): EntityRecord {
  return {
    entity: change.entity,
    entityId: change.entityId,
    value: change.payload,
    revision: change.revision,
    provenance: {
      seq: change.seq,
      originId: change.originId,
      causationId: change.causationId,
      mutationId: change.mutationId,
    },
  }
}

function toMutation(changes: readonly ChangeEnvelope[], cursor: Cursor): CacheMutation {
  // ONE ordered list. See CacheOperation in ports.ts for why three buckets was a
  // bug rather than a style choice.
  const operations: CacheOperation[] = changes.map((change) => {
    if (change.op === 'upsert') {
      return {
        kind: 'upsert',
        entity: change.entity,
        entityId: change.entityId,
        value: change.payload,
        revision: change.revision,
        // ADR 2 D8 — provenance rides BESIDE the value, never inside it.
        provenance: {
          seq: change.seq,
          originId: change.originId,
          causationId: change.causationId,
          mutationId: change.mutationId,
        },
      }
    }
    return { kind: change.op, entity: change.entity, entityId: change.entityId }
  })
  return { operations, cursor }
}

function rungFor(cause: RebootstrapCause): HealRung {
  switch (cause) {
    case 'malformed':
      return 3
    case 'epoch-mismatch':
      return 4
    case 'local-corruption':
      return 5
    case 'schema-version':
      return 6
    default:
      // compacted, resync-required, rescope, cold-start
      return 2
  }
}

/**
 * ADR 2 D7 rung 3 — the shipped semantic validation, restated over the certified
 * frame. D7 calls these protocol law and says not to relitigate them: each one is
 * a class of silent permanent divergence. Amendment 1 D13 changes exactly one
 * thing — contiguity is certified by the covered RANGE, so change seqs need only
 * be non-decreasing and inside it (anchored per-principal rows may SHARE a seq,
 * D14.3) instead of adjacent.
 *
 * Returns a reason string, or null when the frame is well-formed.
 */
export function validateFrame(frame: DeltaFrame): string | null {
  if (!Number.isInteger(frame.fromSeq) || !Number.isInteger(frame.seq)) return 'non-integer range'
  if (frame.fromSeq < 0 || frame.seq < 0) return 'negative range'
  if (frame.fromSeq > frame.seq) return 'inverted covered range'
  if (frame.fromSeq === frame.seq && frame.changes.length > 0) return 'changes in an empty range'
  let previous = frame.fromSeq
  for (const change of frame.changes) {
    if (!Number.isInteger(change.seq)) return 'non-integer seq'
    if (change.seq <= frame.fromSeq || change.seq > frame.seq)
      return 'change outside the covered range'
    if (change.seq < previous) return 'decreasing seq'
    previous = change.seq
    if (change.entity === '' || change.entityId === '') return 'empty entity id'
    // A payload is what distinguishes an upsert from the removal family. Getting
    // this wrong is how an evict becomes indistinguishable from a delete.
    if (change.op === 'upsert' && change.payload === undefined) return 'upsert without payload'
    if (change.op !== 'upsert' && change.payload !== undefined) return `${change.op} with payload`
  }
  return null
}

/** Validate a bootstrap chunk the same way, for adapters that want it up front. */
export function validateBootstrapChunk(chunk: BootstrapChunk): string | null {
  for (const change of chunk.changes) {
    if (change.op !== 'upsert') return 'bootstrap carries a non-upsert row'
    if (change.payload === undefined) return 'bootstrap upsert without payload'
    if (change.seq > chunk.snapshotSeq) return 'bootstrap row above the snapshot point'
  }
  return null
}
