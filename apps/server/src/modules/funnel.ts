import type { MetadataChange, MetadataEntityKind, ServerMessage } from '@podium/protocol'
import { type Ledger, MetadataOplog } from '@podium/sync'
import type { SessionStore } from '../store'
import type { EventBus } from './bus'

export interface WriteFunnelDeps {
  store: SessionStore
  now(): number
  bus: EventBus
  /** Snapshot fan-out (modules/sessions owns the client set): the full-list
   *  snapshot goes to legacy clients; delta-cap clients get it only when
   *  `snapshotToCapClients` is set (rare — diagnostics changes). */
  fanOutSnapshot(snapshot: ServerMessage, opts?: { snapshotToCapClients?: boolean }): void
  /** `metadataDelta` send to delta-cap clients — the tail of THE ordered delta
   *  pipe (see {@link WriteFunnel.flushDeltas}). Called with a non-empty,
   *  seq-ordered batch. */
  sendDelta(changes: MetadataChange[]): void
  /** The write-seam change log ([spec:SP-3fe2] #255/#256/#257). When present,
   *  the funnel bridges its appends onto the bus ('oplog.appended' keeps firing
   *  for EVERY durable change regardless of which seam captured it) and into
   *  the ordered delta pipe (the ledger owns ALL entity kinds now; the legacy
   *  oplog records nothing — P2f deletes it). */
  ledger?: Pick<Ledger, 'onAppended'>
}

/** One publishable state change: the oplog rows for an entity kind plus the
 *  legacy snapshot message that carries the same truth. */
export interface PublishSpec {
  entity: MetadataEntityKind
  rows: { id: string; value: unknown }[]
  snapshot: ServerMessage
  /** Partial upsert (e.g. single-issue update, #22): absence of the other rows
   *  must not read as deletion. */
  partial?: boolean
  /** Rare: force the snapshot to delta-cap clients too (diagnostics changes). */
  snapshotToCapClients?: boolean
}

/**
 * THE single write funnel (issue #13 Phase 2 step 3): every mutation flows
 * authorize → repository write → change append → broadcast (bus + WS), in that
 * order and nowhere else. "Durable before fan-out" (oplog-read-path §2.5)
 * holds by construction rather than by convention at each call site.
 *
 * EVERY entity kind is ledger-owned now ([spec:SP-3fe2] #255 issues, #256
 * sessions, #257 conversations): changes are captured at the WRITE seam by the
 * injected {@link Ledger} (atomic with the entity write), so all fan-outs
 * enter at {@link publishComputed} — the oplog half of {@link publish}/
 * {@link record} REJECTS every spec (see the guard in record) to keep the
 * change log single-writer per entity kind. The legacy broadcast-seam oplog
 * records NOTHING anymore; it and this facade's legacy tail are deleted in P2f.
 *
 * metadataDelta emission is ONE seq-ordered pipe (#256): every appended batch —
 * ledger commits/reconciles AND legacy record() — enters {@link queueDelta} in
 * append order (both writers share one seq sequence over one synchronous
 * connection), coalesces at microtask level (a synchronous burst emits as one
 * batch), and NEVER reorders: the client gap rule (seq !== cursor+1 → heal)
 * turns any reorder into a heal storm.
 */
export class WriteFunnel {
  private readonly oplog: MetadataOplog

  constructor(private readonly deps: WriteFunnelDeps) {
    this.oplog = new MetadataOplog(deps.store.sync, deps.now)
    // Ledger-appended changes (issue/session commits + reconciles, #255/#256)
    // fire the same bus event the legacy record() path does — bus consumers see
    // one unified 'oplog.appended' stream across both seams — and feed the
    // ordered delta pipe. Pipe FIRST, bus second (#247): a reentrant bus
    // listener that commits again re-enters this bridge with LATER seqs before
    // the outer batch would have queued — bus-first therefore delivered
    // [N-1, N+1, N] and delta clients' cursors advanced past N without ever
    // healing the gap. Enqueueing before the emit makes arrival order equal
    // append order no matter what a listener does.
    deps.ledger?.onAppended((changes) => {
      this.queueDelta(changes)
      deps.bus.emit('oplog.appended', { changes })
    })
  }

  /**
   * The full four-stage path. `authorize` throwing stops everything (no write,
   * no oplog, no broadcast); `write` throwing stops the oplog append and the
   * broadcast — a failed repository write must never publish.
   */
  run<T>(op: {
    authorize?: () => void
    write: () => T
    publish?: (result: T) => PublishSpec | null
  }): T {
    op.authorize?.()
    const result = op.write()
    const spec = op.publish?.(result)
    if (spec) this.publishSpec(spec)
    return result
  }

  /** {@link publish} taking a prebuilt {@link PublishSpec} — the shape
   *  {@link run}'s publish stage returns, for callers that build specs via a
   *  spec factory (modules/issues/publish) rather than inline. */
  publishSpec(spec: PublishSpec): void {
    this.publish(spec.entity, spec.rows, spec.snapshot, {
      ...(spec.partial !== undefined ? { partial: spec.partial } : {}),
      ...(spec.snapshotToCapClients !== undefined
        ? { snapshotToCapClients: spec.snapshotToCapClients }
        : {}),
    })
  }

  /** Oplog append + broadcast — the legacy (broadcast-seam) publish tail.
   *  DEAD since #257 (every entity kind is ledger-owned; record() rejects all
   *  specs); kept only so call-site shapes survive until P2f deletes it. */
  publish(
    entity: MetadataEntityKind,
    rows: { id: string; value: unknown }[],
    snapshot: ServerMessage,
    opts: { partial?: boolean; snapshotToCapClients?: boolean } = {},
  ): void {
    this.record(entity, rows, opts.partial ? { partial: true } : {})
    this.deps.fanOutSnapshot(
      snapshot,
      opts.snapshotToCapClients ? { snapshotToCapClients: true } : {},
    )
  }

  /**
   * Fan out a SNAPSHOT whose changes were ALREADY durably appended at the
   * write seam by the Ledger ([spec:SP-3fe2] #255/#256) — commit/reconcile ran
   * before this call, and their appends entered the ordered delta pipe via the
   * onAppended bridge, so this sends NO metadataDelta (emitting one here too
   * would double-deliver every ledger-owned change). Legacy clients get the
   * snapshot exactly as before.
   */
  publishComputed(snapshot: ServerMessage, opts: { snapshotToCapClients?: boolean } = {}): void {
    this.deps.fanOutSnapshot(
      snapshot,
      opts.snapshotToCapClients ? { snapshotToCapClients: true } : {},
    )
  }

  /** Durable oplog append (no snapshot fan-out) — the legacy publish tail lands
   *  here, so 'oplog.appended' + the delta pipe fire for every recorded change. */
  record(
    entity: MetadataEntityKind,
    rows: { id: string; value: unknown }[],
    opts: { partial?: boolean } = {},
  ): MetadataChange[] {
    // SEVERED ([spec:SP-3fe2] #255 issues, #256 sessions, #257 conversations):
    // EVERY entity kind is captured at the WRITE seam by the Ledger
    // (IssueService persist/delete/boot; SessionsService persist/kill/boot;
    // ConversationsService discovery-commit/meta-commit/upstream-reconcile).
    // The legacy broadcast-seam oplog keeps its own baseline, so appending a
    // spec here would DOUBLE-APPEND everything the ledger already wrote —
    // every publish path must route through Ledger.commit/reconcile +
    // publishComputed. Loud so a regressed call site can't silently fork the
    // change log: throw under tests, degrade to no-op in production. The
    // record() body below is dead code until P2f removes it with the oplog.
    if (entity === 'issue' || entity === 'session' || entity === 'conversation') {
      const msg =
        `[funnel] ${entity} spec reached the legacy oplog path — ${entity} changes are ` +
        'ledger-owned (#255/#256/#257); route through Ledger.commit/reconcile + publishComputed'
      if (process.env.VITEST || process.env.NODE_ENV === 'test') throw new Error(msg)
      console.error(msg)
      return []
    }
    const changes = this.oplog.record(entity, rows, opts)
    if (changes.length > 0) {
      // Pipe before bus — same reentrancy ordering rule as the ledger bridge
      // in the constructor (#247).
      this.queueDelta(changes)
      this.deps.bus.emit('oplog.appended', { changes })
    }
    return changes
  }

  /** Cursor catch-up read (sync.changesSince) — null when compacted/future. */
  changesSince(cursor: number | null): MetadataChange[] | null {
    return this.oplog.changesSince(cursor)
  }

  cursor(): number {
    return this.oplog.cursor()
  }

  // ---- THE ordered metadataDelta pipe (#256) ----
  // Appends arrive synchronously and in seq order (single-threaded process, one
  // shared seq sequence across both writers); pendingDelta preserves arrival
  // order, so the flushed batch is seq-ordered by construction. Coalescing is
  // microtask-level: a synchronous burst (boot reconcile, a bind-storm's
  // per-session commits) emits as ONE metadataDelta instead of one per commit.
  private pendingDelta: MetadataChange[] = []
  private deltaFlushScheduled = false

  private queueDelta(changes: MetadataChange[]): void {
    if (changes.length === 0) return
    this.pendingDelta.push(...changes)
    if (this.deltaFlushScheduled) return
    this.deltaFlushScheduled = true
    queueMicrotask(() => {
      // A client-send throw in a microtask would be an uncaught exception; the
      // changes are already durable, so degrade to a logged error (reconnecting
      // clients heal via changesSince).
      try {
        this.flushDeltas()
      } catch (err) {
        console.warn('[funnel] coalesced metadataDelta emission failed', err)
      }
    })
  }

  /** Emit any coalesced (pending) delta batch NOW. Deterministic seam for tests
   *  and dispose; the scheduled microtask then finds nothing and no-ops. */
  flushDeltas(): void {
    this.deltaFlushScheduled = false
    if (this.pendingDelta.length === 0) return
    const batch = this.pendingDelta
    this.pendingDelta = []
    this.deps.sendDelta(batch)
  }
}
