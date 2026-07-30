/**
 * In-memory adapter of the replica storage port.
 *
 * Not only a test double: ADR 6 D1 names "tests / private mode / hard quota
 * session" as a first-class surface served by "an in-memory adapter of the same
 * port", and D4.4 requires `degraded-memory` to be the ONLY fallback when a
 * durable write is denied. POD-374 (IndexedDB) and POD-375 (mobile SQLite) are
 * the durable adapters of this same port.
 *
 * The shape here is the one ADR 6 D4.1 describes: entities, cursor and the outbox
 * are physically ONE store, and a kernel operation touching more than one of them
 * commits in one transaction. The Replica is nonetheless handed only `.cache` —
 * see ports.ts for why that separation is structural rather than advisory.
 *
 * SPAN ISOLATION (ADR 2 D10, the seam settled with POD-370). A span-enrolled write
 * is staged into a span-PRIVATE copy of the region and published once, at commit.
 * It deliberately does NOT mutate the live map and then restore or undo a snapshot:
 * that shape clobbers a concurrent commit, exposes dirty reads to any reader that
 * looks mid-span, and reconstructs ordering by replaying rather than by keeping it.
 * The standalone copy-on-write `applyAtomic` already had the right isolation model;
 * a span extends it in time rather than replacing it.
 */

import type { RetirementIntent } from './overlay'
import type {
  CacheMutation,
  OwnedSyncSpan,
  ReplicaCacheStore,
  SyncSpan,
  SyncSpanParticipant,
} from './ports'
import { ReplicaStoreCorruptError } from './ports'
import type { Cursor, EntityRecord } from './types'

const key = (entity: string, entityId: string): string => `${entity}\u0000${entityId}`

/**
 * Client-local authored truth. It exists NOWHERE ELSE — losing it loses something
 * the user typed (ADR 2 D7). ADR 3 owns its state machine and its horizon; this is
 * only enough of it to prove that no D7 rung can reach it.
 */
export interface OutboxEntry {
  readonly mutationId: string
  readonly entity: string
  readonly entityId: string
  readonly command: unknown
}

/**
 * The outbox region of the physical store.
 *
 * POD-370 owns the real one, including its state machine and horizon. This is the
 * span-enrolling half of the D10 seam from the REPLICA's side: enough to prove that
 * a retirement batch and a cache write publish together or not at all, and that a
 * cache discard cannot reach the region at all.
 */
export class InMemoryOutbox {
  private entries: OutboxEntry[] = []
  private readonly drafts = new Map<SyncSpan, OutboxEntry[]>()
  /** Every batch this region was handed, one entry per call. Proves batching, not a stat. */
  readonly batches: RetirementIntent[][] = []

  enqueue(entry: OutboxEntry): void {
    this.entries.push(entry)
  }

  list(): readonly OutboxEntry[] {
    return [...this.entries]
  }

  retire(mutationId: string): void {
    this.entries = this.entries.filter((e) => e.mutationId !== mutationId)
  }

  /**
   * Retire a whole batch. With a span the effect is staged and published with the
   * rest of that span; repeated batches EXTEND the one draft rather than each
   * starting from the pre-commit entries, which is the resurrection bug per-change
   * calls used to produce.
   */
  retireBatch(matches: readonly RetirementIntent[], span?: SyncSpan): void {
    this.batches.push([...matches])
    if (span === undefined) {
      for (const match of matches) if (match.mutationId !== undefined) this.retire(match.mutationId)
      return
    }
    let draft = this.drafts.get(span)
    if (draft === undefined) {
      draft = [...this.entries]
      this.drafts.set(span, draft)
      span.join({
        publish: () => {
          this.entries = draft as OutboxEntry[]
          this.drafts.delete(span)
        },
        discard: () => {
          this.drafts.delete(span)
        },
      })
    }
    for (const match of matches) {
      if (match.mutationId === undefined) continue
      const at = draft.findIndex((e) => e.mutationId === match.mutationId)
      if (at >= 0) draft.splice(at, 1)
    }
  }
}

/** The staged post-state of the cache region inside one span. */
interface CacheDraft {
  rows: Map<string, EntityRecord>
  cursor: Cursor | null
}

class InMemoryCache implements ReplicaCacheStore {
  private rows = new Map<string, EntityRecord>()
  private cursorValue: Cursor | null = null
  private readonly drafts = new Map<SyncSpan, CacheDraft>()
  /** Flipped by tests to exercise D7 rung 5 / ADR 6 D4.5. */
  corrupt = false
  /** Vetoes the NEXT span commit this region takes part in, at the serialized point. */
  failNextPrepare: string | null = null
  mode: 'durable' | 'degraded-memory' | 'unavailable' = 'degraded-memory'

  constructor(private readonly physical: InMemoryReplicaStore) {}

  readCursor(): Cursor | null {
    this.guard()
    return this.cursorValue
  }

  readEntities(): readonly EntityRecord[] {
    this.guard()
    return [...this.rows.values()]
  }

  read(entity: string, entityId: string): EntityRecord | undefined {
    this.guard()
    return this.rows.get(key(entity, entityId))
  }

  beginSpan(): OwnedSyncSpan {
    // The span belongs to the PHYSICAL store, not to this view: that is what lets
    // two principal-bound views and the outbox publish once between them, and it is
    // why this method hands back an opaque handle rather than anything nameable.
    return this.physical.beginSpan()
  }

  applyAtomic(mutation: CacheMutation, span?: SyncSpan): void {
    this.guard()
    if (span === undefined) {
      // Build the post-state first and swap once: a throw part-way through leaves
      // the pre-operation snapshot, never a torn mix (ADR 6 D4.1).
      const next = new Map(this.rows)
      applyInto(next, mutation)
      this.rows = next
      if (mutation.cursor !== undefined) this.cursorValue = mutation.cursor
      this.physical.countTransaction()
      return
    }
    const draft = this.draftFor(span)
    // EXTENDS the one draft. A second call must not restage from the live map, or
    // the first call's operations would be silently dropped at publish.
    applyInto(draft.rows, mutation)
    if (mutation.cursor !== undefined) draft.cursor = mutation.cursor
  }

  installSnapshot(
    rows: readonly EntityRecord[],
    cursor: Cursor,
    buffered: readonly CacheMutation[],
    span?: SyncSpan,
  ): void {
    this.guard()
    // The atomic swap of ADR 2 D6.4: the staged slice REPLACES the cache (this is
    // the D7 "discard the cache"), the buffered deltas apply on top, and the
    // cursor commits — one transaction, no half-installed replica, and no window
    // in which the replica holds a mixture of two principals' slices.
    const next = new Map<string, EntityRecord>()
    for (const row of rows) next.set(key(row.entity, row.entityId), row)
    let head = cursor
    for (const mutation of buffered) {
      applyInto(next, mutation)
      if (mutation.cursor !== undefined) head = mutation.cursor
    }
    if (span === undefined) {
      this.rows = next
      this.cursorValue = head
      this.physical.countTransaction()
      return
    }
    // An install REPLACES rather than extends, so it overwrites the draft's rows
    // outright — the replacement IS the semantics, unlike applyAtomic's extension.
    const draft = this.draftFor(span)
    draft.rows = next
    draft.cursor = head
  }

  discardCache(): void {
    this.guard()
    // Reaches entities and the cursor. There is no outbox here to reach, and no
    // span either: a discard is a lone single-region operation (D10 clause 2), so
    // it cannot be composed into a transaction that also touches the outbox.
    this.rows = new Map()
    this.cursorValue = null
    this.physical.countTransaction()
  }

  durability(): 'durable' | 'degraded-memory' | 'unavailable' {
    return this.corrupt ? 'unavailable' : this.mode
  }

  private draftFor(span: SyncSpan): CacheDraft {
    const existing = this.drafts.get(span)
    if (existing !== undefined) return existing
    const draft: CacheDraft = { rows: new Map(this.rows), cursor: this.cursorValue }
    this.drafts.set(span, draft)
    span.join({
      prepare: () => {
        this.guard()
        const reason = this.failNextPrepare
        if (reason !== null) {
          this.failNextPrepare = null
          throw new Error(reason)
        }
      },
      publish: () => {
        this.rows = draft.rows
        this.cursorValue = draft.cursor
        this.drafts.delete(span)
      },
      discard: () => {
        this.drafts.delete(span)
      },
    })
    return draft
  }

  private guard(): void {
    if (this.corrupt) throw new ReplicaStoreCorruptError()
  }
}

function applyInto(rows: Map<string, EntityRecord>, mutation: CacheMutation): void {
  // IN ORDER. Never grouped by kind: a frame carrying remove(seq 1) then
  // upsert(seq 2) for one entity must leave the entity PRESENT, and any adapter
  // that batches by type gets that backwards (ADR 2 D9/D13 — order is the
  // correctness property). POD-374/POD-375 inherit this obligation.
  for (const op of mutation.operations) {
    if (op.kind === 'upsert') {
      rows.set(key(op.entity, op.entityId), {
        entity: op.entity,
        entityId: op.entityId,
        value: op.value,
        revision: op.revision,
        provenance: op.provenance,
      })
      continue
    }
    // A tombstone and an eviction both drop the row from the CACHE. They stay
    // separate op kinds so the layer above can still tell them apart
    // (Amendment 1 D14.5) — merging them here would make the distinction
    // unrecoverable exactly where it matters.
    rows.delete(key(op.entity, op.entityId))
  }
}

/** One principal's pair of ports over the shared physical store. */
export interface StoreView {
  readonly cache: ReplicaCacheStore & {
    corrupt: boolean
    failNextPrepare: string | null
    mode: 'durable' | 'degraded-memory' | 'unavailable'
  }
  readonly outbox: InMemoryOutbox
}

/**
 * One span over the physical store: prepare everybody, then publish ONCE.
 *
 * Two phases and not one, because publishing has to be unfailable. Anything that
 * can refuse — a corrupt region, a validation that only holds at the serialized
 * point — refuses in `prepare`, while every draft is still private and abandoning
 * them all costs nothing. Once the first region has published there is no clean way
 * to report a failure in the second, which is exactly the torn state a span exists
 * to prevent.
 */
class InMemorySpan implements OwnedSyncSpan {
  private readonly participants: SyncSpanParticipant[] = []
  /**
   * In-memory adoptions and event emissions, run in registration order strictly
   * AFTER every region has published. A participant that registers nothing is
   * safe by construction — its memory is merely stale until the next apply or
   * rehydrate — which is why there is no abort counterpart to this list.
   */
  private readonly adoptions: (() => void)[] = []
  /**
   * Three states, not a boolean. A caller commits inside `try` and aborts in
   * `catch`, so an abort that follows a VETOED commit is the normal error path and
   * must be a no-op — the drafts were already discarded by the veto. A single
   * `settled` flag could not tell that apart from the two shapes that ARE bugs, so
   * it threw 'span already settled' from the catch and masked the store's real
   * refusal, turning a clean abort into a confusing rethrow.
   */
  private state: 'open' | 'discarded' | 'published' = 'open'

  constructor(private readonly onPublished: () => void) {}

  join(participant: SyncSpanParticipant): void {
    if (this.state !== 'open') throw new Error('cannot join a span that has already settled')
    if (!this.participants.includes(participant)) this.participants.push(participant)
  }

  onCommit(adopt: () => void): void {
    if (this.state !== 'open') throw new Error('cannot enrol in a span that has already settled')
    this.adoptions.push(adopt)
  }

  commit(): void {
    if (this.state !== 'open') throw new Error('span already settled')
    try {
      for (const participant of this.participants) participant.prepare?.()
    } catch (error) {
      // A veto aborts the WHOLE span. Nothing published, nothing retired.
      this.discardAll()
      throw error
    }
    this.state = 'published'
    for (const participant of this.participants) participant.publish()
    // ONE transaction for the whole span, not one per participant (D10 clause 5).
    this.onPublished()
    // Strictly after durability: an observation that outran its own commit would
    // be a lie no later hook could retract.
    for (const adopt of this.adoptions) adopt()
  }

  abort(): void {
    // Idempotent, so the `catch (…) { span.abort() }` idiom is always safe.
    if (this.state === 'discarded') return
    // Still loud for the one shape that is genuinely wrong: the drafts are already
    // live in the store, so there is nothing this could undo.
    if (this.state === 'published') throw new Error('cannot abort a span that already published')
    this.discardAll()
  }

  private discardAll(): void {
    this.state = 'discarded'
    for (const participant of this.participants) participant.discard?.()
    // Adoptions are dropped rather than run: nothing was published, so adopting
    // would put memory AHEAD of durable truth — the one direction this seam makes
    // unreachable.
    this.adoptions.length = 0
  }
}

/**
 * One physical store holding both regions (ADR 6 D4.1), handing out two ports.
 * The Replica gets `.cache`; the outbox owner (POD-370) gets `.outbox`.
 *
 * `viewFor` exists because under private-by-default one physical store can back
 * more than one principal-bound view (ADR 6 D4.1 + Amendment 1 D15.3), and the
 * D10 span they share must still publish once between them.
 */
export class InMemoryReplicaStore {
  private transactionCount = 0
  private readonly views = new Map<string, StoreView>()
  readonly cache: StoreView['cache']
  readonly outbox: InMemoryOutbox

  constructor() {
    const first = this.viewFor('default')
    this.cache = first.cache
    this.outbox = first.outbox
  }

  /** The ports for one principal. Stable per name; every view shares this store. */
  viewFor(principal: string): StoreView {
    const existing = this.views.get(principal)
    if (existing !== undefined) return existing
    const view: StoreView = { cache: new InMemoryCache(this), outbox: new InMemoryOutbox() }
    this.views.set(principal, view)
    return view
  }

  beginSpan(): OwnedSyncSpan {
    return new InMemorySpan(() => {
      this.transactionCount += 1
    })
  }

  /** Simulate ADR 6 D4.5 corruption / D7 rung 5. */
  setCorrupt(corrupt: boolean): void {
    this.cache.corrupt = corrupt
  }

  /** Physical publishes: autocommitted writes plus one per committed span. */
  get transactions(): number {
    return this.transactionCount
  }

  countTransaction(): void {
    this.transactionCount += 1
  }
}
