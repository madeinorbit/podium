import type { MetadataChange, ServerMessage } from '@podium/protocol'
import type { Ledger } from '@podium/sync'
import type { EventBus } from './bus'

export interface WriteFunnelDeps {
  bus: EventBus
  /** Snapshot fan-out (modules/sessions owns the client set): the full-list
   *  snapshot goes to legacy clients; delta-cap clients get it only when
   *  `snapshotToCapClients` is set (rare — diagnostics changes). */
  fanOutSnapshot(snapshot: ServerMessage, opts?: { snapshotToCapClients?: boolean }): void
  /** `metadataDelta` send to delta-cap clients — the tail of THE ordered delta
   *  pipe (see {@link WriteFunnel.flushDeltas}). Called with a non-empty,
   *  seq-ordered batch. */
  sendDelta(changes: MetadataChange[]): void
  /** The write-seam change log ([spec:SP-3fe2] #255/#256/#257) — the SINGLE
   *  writer of the durable `changes` table. The funnel bridges its appends onto
   *  the bus ('oplog.appended' fires for EVERY durable change) and into the
   *  ordered delta pipe, and serves cursor reads through it. */
  ledger: Pick<Ledger, 'onAppended' | 'changesSince' | 'cursor'>
}

/**
 * THE write funnel (issue #13 Phase 2 step 3; slimmed to its real shape in
 * P2f, [spec:SP-3fe2] #258): every mutation flows authorize → repository
 * write → change append → broadcast, in that order and nowhere else. "Durable
 * before fan-out" (oplog-read-path §2.5) holds by construction rather than by
 * convention at each call site.
 *
 * EVERY entity kind is ledger-owned ([spec:SP-3fe2] #255 issues, #256
 * sessions, #257 conversations): changes are captured at the WRITE seam by the
 * injected {@link Ledger} (atomic with the entity write). What survives here:
 *
 *  - {@link run} — authorize → write ordering for the write-only call sites
 *    (issue mail, subscriptions: durable writes with no publishable change);
 *  - {@link publishComputed} — legacy-snapshot fan-out for changes the ledger
 *    already durably appended;
 *  - the ordered metadataDelta pipe ({@link flushDeltas}) fed by the ledger's
 *    onAppended bridge;
 *  - {@link changesSince}/{@link cursor} passthroughs to the ledger for the
 *    `sync.changesSince` read path.
 *
 * The legacy broadcast-seam oplog (MetadataOplog) and its publish/record tail
 * were deleted in P2f — the ledger is the only change-log writer.
 *
 * metadataDelta emission is ONE seq-ordered pipe (#256): every appended batch
 * enters {@link queueDelta} in append order, coalesces at microtask level (a
 * synchronous burst emits as one batch), and NEVER reorders: the client gap
 * rule (seq !== cursor+1 → heal) turns any reorder into a heal storm.
 */
export class WriteFunnel {
  constructor(private readonly deps: WriteFunnelDeps) {
    // Ledger-appended changes (commits + reconciles, #255/#256/#257) fire the
    // bus event every change-log consumer subscribes to and feed the ordered
    // delta pipe. Pipe FIRST, bus second (#247): a reentrant bus listener that
    // commits again re-enters this bridge with LATER seqs before the outer
    // batch would have queued — bus-first therefore delivered [N-1, N+1, N]
    // and delta clients' cursors advanced past N without ever healing the gap.
    // Enqueueing before the emit makes arrival order equal append order no
    // matter what a listener does.
    deps.ledger.onAppended((changes) => {
      this.queueDelta(changes)
      deps.bus.emit('oplog.appended', { changes })
    })
  }

  /**
   * Authorize → write ordering for the write-only call sites (issue mail,
   * subscriptions — durable writes whose fan-out, if any, happens elsewhere).
   * `authorize` throwing stops everything: a forbidden op must never write.
   */
  run<T>(op: { authorize?: () => void; write: () => T }): T {
    op.authorize?.()
    return op.write()
  }

  /**
   * Fan out a SNAPSHOT whose changes were ALREADY durably appended at the
   * write seam by the Ledger ([spec:SP-3fe2] #255/#256/#257) — commit/reconcile
   * ran before this call, and their appends entered the ordered delta pipe via
   * the onAppended bridge, so this sends NO metadataDelta (emitting one here
   * too would double-deliver every ledger-owned change). Legacy clients get
   * the snapshot exactly as before.
   */
  publishComputed(snapshot: ServerMessage, opts: { snapshotToCapClients?: boolean } = {}): void {
    this.deps.fanOutSnapshot(
      snapshot,
      opts.snapshotToCapClients ? { snapshotToCapClients: true } : {},
    )
  }

  /** Cursor catch-up read (sync.changesSince) — null when compacted/future. */
  changesSince(cursor: number | null): MetadataChange[] | null {
    return this.deps.ledger.changesSince(cursor)
  }

  cursor(): number {
    return this.deps.ledger.cursor()
  }

  // ---- THE ordered metadataDelta pipe (#256) ----
  // Appends arrive synchronously and in seq order (single-threaded process,
  // one writer over one synchronous connection); pendingDelta preserves
  // arrival order, so the flushed batch is seq-ordered by construction.
  // Coalescing is microtask-level: a synchronous burst (boot reconcile, a
  // bind-storm's per-session commits) emits as ONE metadataDelta instead of
  // one per commit.
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
