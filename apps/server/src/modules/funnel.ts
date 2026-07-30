import type { MetadataChange, ServerMessage } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL, type AuthorityPort, type ScopedChange } from '@podium/sync'
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
  /**
   * THE AUTHORITY (POD-305) — the sync kernel's write seam and the SINGLE writer
   * of the durable `changes` table.
   *
   * This used to be a `Pick<Ledger, …>`. The funnel now holds the kernel role
   * itself: `run` goes through `authority.commit`, so the authorize→write order
   * this class is named for is enforced by the kernel rather than by this class
   * remembering to call things in order. What remains here is the LEGACY
   * SNAPSHOT TAIL and the bus bridge — transport concerns of this app, which
   * POD-308 deletes at the wire cutover.
   *
   * Must be the SAME instance the Ledger facade wraps (`ledger.authority`):
   * two Authorities over one store would each keep their own dedup baseline and
   * their own ordered queue.
   */
  authority: AuthorityPort
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
    //
    // THE PRINCIPAL, AND WHICH HALF OF SCOPING THIS SITE HAS (POD-1077). The
    // Authority's feed is per-principal now (ADR 2 Am1 D12), and this subscription
    // names `DEVICE_GRADE_PRINCIPAL` because that is what this transport can
    // honestly authenticate: `auth-store.ts` is one shared password and
    // `gateway/client-principal.ts` still asserts `CLIENT_PRINCIPAL_GRADE ===
    // 'device'`, so two connections presenting it are indistinguishable AS PERSONS.
    // The mechanism is built and this seam is the one that cannot yet use it —
    // per-connection principals arrive with per-user login and POD-308's cutover.
    deps.authority.subscribe(DEVICE_GRADE_PRINCIPAL, (delivery) => {
      // The `rescope` arm is unreachable for a principal with no grant edges, and
      // the pre-cutover wire could not express it anyway. Handled rather than
      // cast: "cannot happen" plus a cast is how a silently dropped batch ships.
      if (delivery.kind !== 'batch') {
        throw new Error(
          `WriteFunnel: the Authority produced a '${delivery.kind}' delivery for the device-grade ` +
            'principal, which the pre-cutover wire cannot express (POD-308 owns the new one).',
        )
      }
      const wire = delivery.changes.map(toWireChange)
      this.queueDelta(wire)
      deps.bus.emit('oplog.appended', { changes: wire })
    })
  }

  /**
   * Authorize → write ordering for the write-only call sites (issue mail,
   * subscriptions — durable writes whose fan-out, if any, happens elsewhere).
   * `authorize` throwing stops everything: a forbidden op must never write.
   */
  run<T>(op: { authorize?: () => void; write: () => T }): T {
    // Through the KERNEL, so the order is the Authority's to enforce rather than
    // this method's to remember. `changes: () => []` is the honest declaration
    // for these call sites: issue mail, subscriptions and locks are durable
    // writes with no publishable change, so there is nothing to append — which
    // is a different statement from "we did not get round to declaring it", and
    // the empty array says so at each call rather than in a comment here.
    //
    // No `arbitrate`, so this cannot be rejected; the outcome is committed by
    // construction. Asserted rather than cast, because "cannot happen" plus a
    // cast is how a silently dropped write ships.
    const outcome = this.deps.authority.commit({
      ...(op.authorize === undefined ? {} : { authorize: op.authorize }),
      write: op.write,
      changes: () => [],
    })
    if (outcome.outcome !== 'committed') {
      throw new Error(
        `WriteFunnel.run: the Authority rejected a write it was never asked to arbitrate ` +
          `(${outcome.reason}). That is a kernel invariant break, not a caller error.`,
      )
    }
    return outcome.result
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
    const delivery = this.deps.authority.changesSince(cursor, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null || delivery.kind !== 'batch') return null
    return delivery.changes.map(toWireChange)
  }

  cursor(): number {
    return this.deps.authority.cursor()
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

/**
 * The kernel's sequenced change → the pre-cutover wire row.
 *
 * The kernel spells the target-id key `entityId` and the wire spells it `id`.
 * POD-308 owns reconciling the two at the cutover; until then this is the ONE
 * place in the server where they meet, so that rename is one deletion.
 */
function toWireChange(change: ScopedChange): MetadataChange {
  // The pre-cutover wire has two ops; `evict` is the third (Amendment 1 D14.1)
  // and POD-308 owns bringing the wire onto the scoped vocabulary. Refused rather
  // than coerced into `remove`, which D14.5 makes normative: the replica would
  // render a revoked share as a deletion and a later re-grant as a resurrection.
  if (change.op === 'evict') {
    throw new Error(
      "WriteFunnel: an 'evict' row reached the pre-cutover wire, which cannot express it. " +
        "'remove' is NOT a substitute (ADR 2 Am1 D14.5) — the wire cutover (POD-308) comes first.",
    )
  }
  const base = { seq: change.seq, id: change.entityId, op: change.op }
  return (
    change.op === 'upsert'
      ? { ...base, entity: change.entity, value: change.value }
      : { ...base, entity: change.entity }
  ) as MetadataChange
}
