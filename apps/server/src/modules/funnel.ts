import type { MetadataChange } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL, type AuthorityPort, type ScopedChange, type ScopedDelivery } from '@podium/sync'
import type { EventBus } from './bus'

export interface WriteFunnelDeps {
  bus: EventBus
  /**
   * THE SERVING EDGE (POD-1203) — the one tail entity truth leaves through.
   *
   * This replaces the two that used to be here: `fanOutSnapshot`, a full-list
   * snapshot fan-out each feature drove by rebuilding its own list, and
   * `sendDelta`, the raw `metadataDelta` send. The first is deleted outright; the
   * second moved DOWN, into `gateway/feed-serving.ts`, where a frame is certified
   * per connection and translated per negotiated wire version. What is left here
   * is the ordering and the coalescing — this app's two contributions to the pipe
   * — and nothing about message shapes at all.
   */
  serving: FeedServingPort
  /**
   * THE AUTHORITY (POD-305) — the sync kernel's write seam and the SINGLE writer
   * of the durable `changes` table.
   *
   * Must be the SAME instance the Ledger facade wraps (`ledger.authority`):
   * two Authorities over one store would each keep their own dedup baseline and
   * their own ordered queue.
   */
  authority: AuthorityPort
  /**
   * A coalesced batch has been handed to the serving edge, certified through
   * `seq`.
   *
   * The prepared-publication worker (`modules/sessions`) keeps its own cursor
   * over the same log, and it has to advance ONCE per batch rather than once per
   * recipient. That is why this is a separate call and not something a per-peer
   * sink could do: it is a fact about the FEED's position, not about a delivery.
   */
  onPublished(seq: number): void
}

/** What the funnel needs of the serving edge. Narrow so a test can drive it. */
export interface FeedServingPort {
  publish(principal: typeof DEVICE_GRADE_PRINCIPAL, delivery: ScopedDelivery): void
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
 *  - the ordered, COALESCED delivery pipe ({@link flushDeltas}) fed by the
 *    Authority's per-principal subscription;
 *  - {@link changesSince}/{@link cursor} passthroughs for the
 *    `sync.changesSince` read path.
 *
 * WHAT LEFT AT THE SERVING-PATH CUTOVER (POD-1203): `publishComputed`, the
 * legacy full-list snapshot tail. Thirteen call sites across five features each
 * rebuilt their own list and handed it here to be fanned out beside the delta
 * pipe — two paths over one truth, agreeing by assumption. Legacy clients still
 * receive those messages; they are now built at the connection boundary, from
 * this feed, in `gateway/legacy-wire-v1-adapter.ts`, and they expire with it.
 *
 * ---------------------------------------------------------------------------
 * COALESCING HAPPENS HERE, BEFORE FRAMING, AND THAT ORDER IS THE DECISION
 * ---------------------------------------------------------------------------
 *
 * A synchronous burst — boot reconcile, a bind-storm's per-session commits —
 * arrives as many appends. Coalescing them at microtask level BEFORE they reach
 * `FeedPublisher` means the burst becomes ONE certified frame per connection,
 * exactly as it used to become one `metadataDelta`. Coalescing after framing is
 * not available: a certified range may only be merged by range extension and
 * only when at most one side carries rows (D13.2/D13.3), so the publisher would
 * have had to emit one frame per commit and a reconnect storm would multiply
 * them by the connection count.
 *
 * Merging two evaluated ranges is sound in exactly the way the publisher's own
 * coalescing is: `(a, b]` followed by `(b, c]` is `(a, c]`, the rows keep their
 * seq order, and no seq between them goes uncertified. A `rescope` cannot be
 * merged into anything — it is a different arm with a different meaning — so it
 * flushes what is pending and goes out on its own, in order.
 */
export class WriteFunnel {
  constructor(private readonly deps: WriteFunnelDeps) {
    // Ledger-appended changes (commits + reconciles, #255/#256/#257) fire the
    // bus event every change-log consumer subscribes to and feed the ordered
    // delta pipe. Pipe FIRST, bus second (#247): a reentrant bus listener that
    // commits again re-enters this bridge with LATER seqs before the outer
    // batch would have queued — bus-first therefore delivered [N-1, N+1, N] and
    // delta clients' cursors advanced past N without ever healing the gap.
    // Enqueueing before the emit makes arrival order equal append order no
    // matter what a listener does.
    //
    // THE PRINCIPAL, AND WHICH HALF OF SCOPING THIS SITE HAS (POD-1077). The
    // Authority's feed is per-principal (ADR 2 Am1 D12), and this subscription
    // names `DEVICE_GRADE_PRINCIPAL` because that is what this transport can
    // honestly authenticate: `auth-store.ts` is one shared password and
    // `gateway/client-principal.ts` still asserts `CLIENT_PRINCIPAL_GRADE ===
    // 'device'`, so two connections presenting it are indistinguishable AS
    // PERSONS. Per-connection principals arrive with per-user login.
    deps.authority.subscribe(DEVICE_GRADE_PRINCIPAL, (delivery) => {
      // BOTH ARMS ARE NOW EXPRESSIBLE, which is what the cutover bought.
      // POD-1077 had to THROW here on a `rescope`, because the pre-cutover wire
      // had no frame for "your rights changed, re-bootstrap" and degrading it to
      // silence is the invisible-gap failure. Wire v2 carries it, so it rides the
      // same ordered pipe as everything else.
      //
      // The `evict` refusal that lived here has MOVED rather than been dropped —
      // it is in `legacy-wire-v1-adapter.ts`, at the only boundary where an evict
      // is genuinely inexpressible. That is the point of the cutover: a scoped
      // principal must be served wire v2 or not served, and the failure is loud
      // at the edge that cannot express it instead of loud for everyone.
      this.queue(delivery)
      if (delivery.kind !== 'batch') return
      const wire = delivery.changes.flatMap(toBusChange)
      if (wire.length > 0) deps.bus.emit('oplog.appended', { changes: wire })
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

  /** Cursor catch-up read (sync.changesSince) — null when compacted/future. */
  changesSince(cursor: number | null): MetadataChange[] | null {
    const delivery = this.deps.authority.changesSince(cursor, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null || delivery.kind !== 'batch') return null
    return delivery.changes.flatMap(toBusChange)
  }

  cursor(): number {
    return this.deps.authority.cursor()
  }

  // ---- THE ordered, coalesced delivery pipe (#256) ----
  // Appends arrive synchronously and in seq order (single-threaded process, one
  // writer over one synchronous connection); `pending` preserves arrival order,
  // so the flushed delivery is seq-ordered by construction.
  private pending: ScopedDelivery[] = []
  private flushScheduled = false

  private queue(delivery: ScopedDelivery): void {
    this.pending.push(delivery)
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      // A send throw in a microtask would be an uncaught exception; the changes
      // are already durable, so degrade to a logged error (reconnecting clients
      // heal via their next bootstrap).
      try {
        this.flushDeltas()
      } catch (err) {
        console.warn('[funnel] coalesced feed publication failed', err)
      }
    })
  }

  /** Emit any coalesced (pending) delivery NOW. Deterministic seam for tests
   *  and dispose; the scheduled microtask then finds nothing and no-ops. */
  flushDeltas(): void {
    this.flushScheduled = false
    if (this.pending.length === 0) return
    const queued = this.pending
    this.pending = []
    for (const delivery of coalesce(queued)) {
      // POSITION FIRST, DELIVERY SECOND, and the order is transcribed from the
      // deleted `sendMetadataDelta`: it advanced the prepared-publication
      // worker's cursor and scheduled a rebuild BEFORE walking the connections.
      // A connection whose view is being rebuilt BUFFERS the batch instead of
      // receiving it, so delivering first would hand a global-publication client
      // a batch the worker is about to supersede.
      this.deps.onPublished(delivery.throughSeq)
      this.deps.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)
    }
  }
}

/**
 * Merge adjacent `batch` deliveries; never merge across a `rescope`.
 *
 * Range extension only, which is D13.2's rule and the same one the publisher's
 * watermark slot obeys: `(a, b]` then `(b, c]` is `(a, c]` and the rows keep
 * their order. `throughSeq` therefore comes from the LAST delivery merged — the
 * head of the evaluated range — and never from the last row, which is the
 * distinction that makes a watermark a watermark.
 */
function coalesce(deliveries: readonly ScopedDelivery[]): ScopedDelivery[] {
  const out: ScopedDelivery[] = []
  for (const delivery of deliveries) {
    const previous = out[out.length - 1]
    if (delivery.kind === 'batch' && previous?.kind === 'batch') {
      out[out.length - 1] = {
        kind: 'batch',
        throughSeq: delivery.throughSeq,
        changes: [...previous.changes, ...delivery.changes],
      }
      continue
    }
    out.push(delivery)
  }
  return out
}

/**
 * The kernel's sequenced change → the shape the in-process bus carries.
 *
 * NOT a wire mapping — `oplog.appended` is an internal event (message-delivery
 * eligibility reads it), and the wire's spelling of a change row now lives at the
 * edge. An `evict` produces NO bus row: it is a per-principal VISIBILITY move,
 * not a durable entity transition, and every consumer of this event asks "did
 * this entity change?". Feeding one through as a remove is the ADR 2 Am1 D14.5
 * error in a second place.
 */
function toBusChange(change: ScopedChange): MetadataChange[] {
  if (change.op === 'evict') return []
  const base = { seq: change.seq, id: change.entityId, op: change.op }
  return [
    (change.op === 'upsert'
      ? { ...base, entity: change.entity, value: change.value }
      : { ...base, entity: change.entity }) as MetadataChange,
  ]
}
