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

import type { MutationId } from '@podium/model'
import { ChangedKeyDraft } from '../adapters/changed-key-draft'
import {
  type CacheMeta,
  cursorTriple,
  EMPTY_CACHE_META,
  isMainRow,
  nextCacheMeta,
} from './cache-state'
import {
  DiskIndex,
  DiskIndexDraft,
  type DiskIndexReader,
  DiskOnlyWrites,
  installResidentRows,
  stageIndexComesWith,
  stageIndexInstances,
  stageRow,
  unloadResident,
} from './disk-index'
import type { RetirementIntent } from './overlay'
import type {
  CacheMutation,
  OwnedSyncSpan,
  ReplicaCacheStore,
  SnapshotVersions,
  SyncSpan,
  SyncSpanParticipant,
  SyncUnitOfWork,
} from './ports'
import { ReplicaStoreCorruptError } from './ports'
import { RowMirror } from './row-mirror'
import type { StubTableReader } from './stub-table'
import type { CachePolicy, Cursor, EntityRecord, InstanceRecord, KindTokens } from './types'

const key = (entity: string, entityId: string): string => `${entity}\u0000${entityId}`

/**
 * Client-local authored truth. It exists NOWHERE ELSE — losing it loses something
 * the user typed (ADR 2 D7). ADR 3 owns its state machine and its horizon; this is
 * only enough of it to prove that no D7 rung can reach it.
 */
export interface OutboxEntry {
  readonly mutationId: MutationId
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

  retire(mutationId: MutationId): void {
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

/**
 * The staged post-state of the cache region inside one span: the keys it
 * changes over the published rows (or, for an install, the rows replacing
 * them), never a copy of every row.
 */
interface CacheDraft {
  rows: ChangedKeyDraft<EntityRecord, RowMirror>
  disk: ChangedKeyDraft<EntityRecord>
  index: DiskIndexDraft
  /** POD-7160 — rows written to disk and not to memory. */
  diskOnly: DiskOnlyWrites
  meta: CacheMeta
}

/**
 * POD-7159 — this adapter's "disk" is a map of every row it holds, beside
 * the resident set in memory (`rows`), so the two layers behave here as on
 * the durable adapters: an unloaded instance leaves memory and stays here.
 */
class InMemoryCache implements ReplicaCacheStore {
  // POD-7115: a stub is kept only in its record type's stub table.
  private rows = new RowMirror()
  private disk = new Map<string, EntityRecord>()
  private index = new DiskIndex()
  private meta: CacheMeta = EMPTY_CACHE_META
  private readonly drafts = new Map<SyncSpan, CacheDraft>()
  corrupt = false
  failNextPrepare: string | null = null
  mode: 'durable' | 'degraded-memory' | 'unavailable' = 'degraded-memory'

  constructor(private readonly physical: InMemoryReplicaStore) {}

  readCursor(): Cursor | null {
    this.guard()
    return cursorTriple(this.meta.cursor)
  }

  readKindTokens(): KindTokens | undefined {
    this.guard()
    return this.meta.cursor?.kindTokens
  }

  readKindReloadVersion(): number | undefined {
    this.guard()
    return this.meta.cursor?.kindReloadVersion
  }

  readInstances(): ReadonlyMap<string, InstanceRecord> {
    this.guard()
    return this.meta.instances
  }

  readPolicy(): CachePolicy | null {
    this.guard()
    return this.meta.policy
  }

  readLoadingSince(): number | null {
    this.guard()
    return this.meta.loadingSince
  }

  readDiskIndex(): DiskIndexReader {
    this.guard()
    return this.index
  }

  async readDiskRows(keys: readonly string[]): Promise<readonly EntityRecord[]> {
    this.guard()
    const out: EntityRecord[] = []
    for (const key of keys) {
      const row = this.disk.get(key)
      if (row !== undefined) out.push(row)
    }
    return out
  }

  installResident(rows: readonly EntityRecord[]): readonly EntityRecord[] {
    this.guard()
    return installResidentRows(this.rows, this.index, rows)
  }

  markInMemory(instanceKeys: readonly string[]): void {
    this.guard()
    this.index.setInMemory(
      instanceKeys.filter((key) => this.meta.instances.has(key)),
      true,
    )
  }

  unload(instanceKeys: readonly string[]): readonly Pick<EntityRecord, 'entity' | 'entityId'>[] {
    this.guard()
    return unloadResident(this.rows, this.index, instanceKeys)
  }

  touchInstance(instanceKey: string, at: number): void {
    this.index.touch(instanceKey, at)
  }

  readEntities(): readonly EntityRecord[] {
    this.guard()
    return this.rows.mainRows()
  }

  read(entity: string, entityId: string): EntityRecord | undefined {
    this.guard()
    const row = this.rows.getMain(key(entity, entityId))
    return row === undefined || !isMainRow(row) ? undefined : row
  }

  readRow(entity: string, entityId: string): EntityRecord | undefined {
    this.guard()
    return this.rows.get(key(entity, entityId))
  }

  readStubs(): readonly EntityRecord[] {
    this.guard()
    return this.rows.stubRows()
  }

  readStubTable(entity: string): StubTableReader | undefined {
    this.guard()
    return this.rows.stubTable(entity)
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
      // Stage the post-state first and publish once: a throw part-way through
      // leaves the pre-operation rows, never a torn mix (ADR 6 D4.1).
      const draft = this.newDraft()
      applyInto(draft, this.rows, this.disk, mutation)
      const meta = nextCacheMeta(this.meta, mutation).meta
      this.publishDraft(draft, meta)
      this.physical.countTransaction()
      return
    }
    const draft = this.draftFor(span)
    // EXTENDS the one draft. A second call must not restage from the live map, or
    // the first call's operations would be silently dropped at publish.
    applyInto(draft, this.rows, this.disk, mutation)
    draft.meta = nextCacheMeta(draft.meta, mutation).meta
  }

  private newDraft(): CacheDraft {
    return {
      rows: new ChangedKeyDraft<EntityRecord, RowMirror>(),
      disk: new ChangedKeyDraft<EntityRecord>(),
      index: new DiskIndexDraft(this.index),
      diskOnly: new DiskOnlyWrites(),
      meta: this.meta,
    }
  }

  private publishDraft(draft: CacheDraft, meta: CacheMeta): void {
    this.rows = draft.rows.publish(this.rows)
    draft.diskOnly.publish(this.rows)
    this.disk = draft.disk.publish(this.disk)
    this.index.publish(draft.index)
    this.meta = meta
  }

  installSnapshot(
    rows: readonly EntityRecord[],
    cursor: Cursor,
    buffered: readonly CacheMutation[],
    span?: SyncSpan,
    versions: SnapshotVersions = {},
  ): void {
    this.guard()
    // The atomic swap of ADR 2 D6.4: the staged slice REPLACES the cache (this is
    // the D7 "discard the cache"), the buffered deltas apply on top, and the
    // cursor commits — one transaction, no half-installed replica, and no window
    // in which the replica holds a mixture of two principals' slices.
    const draft = span === undefined ? undefined : this.draftFor(span)
    const replacement = RowMirror.of(rows)
    const diskRows = new Map<string, EntityRecord>()
    const index = new DiskIndexDraft(this.index)
    index.clearAll()
    for (const row of rows) {
      const at = key(row.entity, row.entityId)
      diskRows.set(at, row)
      index.row(at, row)
    }
    const next: CacheDraft = {
      rows: new ChangedKeyDraft<EntityRecord, RowMirror>(replacement),
      disk: new ChangedKeyDraft<EntityRecord>(diskRows),
      index,
      diskOnly: new DiskOnlyWrites(),
      meta: EMPTY_CACHE_META,
    }
    let meta = nextCacheMeta(EMPTY_CACHE_META, {
      operations: [],
      cursor,
      ...(versions.kindTokens === undefined ? {} : { kindTokens: versions.kindTokens }),
      ...(versions.kindReloadVersion === undefined
        ? {}
        : { kindReloadVersion: versions.kindReloadVersion }),
    }).meta
    for (const mutation of buffered) {
      applyInto(next, replacement, diskRows, mutation)
      meta = nextCacheMeta(meta, mutation).meta
    }
    if (draft === undefined) {
      this.rows = replacement
      next.diskOnly.publish(replacement)
      this.disk = diskRows
      this.index.publish(index)
      this.meta = meta
      this.physical.countTransaction()
      return
    }
    // An install REPLACES rather than extends, so it overwrites the draft's rows
    // outright — the replacement IS the semantics, unlike applyAtomic's extension.
    draft.rows = next.rows
    draft.disk = next.disk
    draft.index = index
    draft.diskOnly = next.diskOnly
    draft.meta = meta
  }

  discardCache(): void {
    this.guard()
    // Reaches entities and the cursor. There is no outbox here to reach, and no
    // span either: a discard is a lone single-region operation (D10 clause 2), so
    // it cannot be composed into a transaction that also touches the outbox.
    this.rows = new RowMirror()
    this.disk = new Map()
    this.index.clear()
    this.meta = EMPTY_CACHE_META
    this.physical.countTransaction()
  }

  durability(): 'durable' | 'degraded-memory' | 'unavailable' {
    return this.corrupt ? 'unavailable' : this.mode
  }

  private draftFor(span: SyncSpan): CacheDraft {
    const existing = this.drafts.get(span)
    if (existing !== undefined) return existing
    const draft = this.newDraft()
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
        this.publishDraft(draft, draft.meta)
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

function applyInto(
  draft: CacheDraft,
  base: RowMirror,
  disk: ReadonlyMap<string, EntityRecord>,
  mutation: CacheMutation,
): void {
  // IN ORDER. Never grouped by kind: a frame carrying remove(seq 1) then
  // upsert(seq 2) for one entity must leave the entity PRESENT, and any adapter
  // that batches by type gets that backwards (ADR 2 D9/D13 — order is the
  // correctness property). POD-374/POD-375 inherit this obligation.
  for (const op of mutation.operations) {
    const at = key(op.entity, op.entityId)
    // POD-7160: newest wins against the row in memory or, only on disk, its index entry.
    const staged = stageRow(at, op, draft.rows.get(at, base), draft.diskOnly, draft.index)
    if (staged === undefined) continue
    const next = staged.row
    // A tombstone and an eviction both drop the row from the CACHE. They stay
    // separate op kinds so the layer above can still tell them apart
    // (Amendment 1 D14.5) — merging them here would make the distinction
    // unrecoverable exactly where it matters.
    if (next === null) {
      draft.rows.delete(at)
      if (draft.disk.get(at, disk) !== undefined) draft.disk.delete(at)
      draft.index.row(at, null)
    } else {
      if (staged.memory) draft.rows.set(at, next)
      draft.disk.set(at, next)
      draft.index.row(at, next, op.kind === 'upsert' ? op.holders : undefined)
    }
  }
  stageIndexInstances(draft.index, mutation.instances)
  stageIndexComesWith(draft.index, mutation.comesWith)
}

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
  private transactQueue: Promise<unknown> = Promise.resolve()
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

  /**
   * ADR 2 D10's unit of work over this physical store (POD-1158).
   *
   * A storage adapter owes this alongside its ports: the Replica is a PARTICIPANT and
   * needs a transaction boundary handed to it, and the boundary belongs to whoever
   * owns the physical store. POD-374 (IndexedDB) and POD-375 (SQLite) owe the same
   * object over their own native transactions.
   *
   * The body sees the span NARROWED to `SyncSpan`, so no participant can settle a
   * transaction it did not open; only this closure holds `commit`/`abort`. Independent
   * calls are SERIALIZED rather than joined — there is deliberately no ambient
   * "current span" to pick up, because a process-wide flag cannot tell lexical nesting
   * from an unrelated concurrent caller, and a mutation absorbed into a stranger's
   * transaction reports success before durability and then vanishes when that
   * transaction aborts.
   */
  readonly unitOfWork: SyncUnitOfWork = {
    transact: async <T>(body: (span: SyncSpan) => Promise<T>): Promise<T> => {
      const run = this.transactQueue.then(async () => {
        const span = this.beginSpan()
        try {
          const result = await body(span)
          span.commit()
          return result
        } catch (error) {
          span.abort()
          throw error
        }
      })
      this.transactQueue = run.then(
        () => undefined,
        () => undefined,
      )
      return await run
    },
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
