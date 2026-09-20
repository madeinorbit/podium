/**
 * THE STORE-NEUTRAL CLIENT `Replica` FACADE (POD-1228, for POD-1223).
 *
 * The engine reads its world through the `Replica` interface in `../replica.ts`,
 * whose only implementation is the outgoing TanStack one. This module is the
 * second implementation: the same interface, backed by the kernel Replica's
 * cache instead. Nothing in the engine changes — the cutover is a different
 * object arriving through the existing `createReplicaFn` seam.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS BUILT HERE, AND UNDER A DIFFERENT ISSUE THAN THE BRIEF EXPECTED
 * ---------------------------------------------------------------------------
 *
 * POD-376 recorded this file as POD-377's, and POD-1223's brief repeats it.
 * POD-377 shipped and closed WITHOUT it: its merge landed the D6 legacy-snapshot
 * migration, and `apps/mobile` still constructs the TanStack `createReplica`. So
 * the file was owned by an issue that finished elsewhere. It is written once,
 * here, store-neutral, so mobile adopts this one rather than the fork this
 * programme exists to end.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES, AND WHY REFUSING IS THE FEATURE
 * ---------------------------------------------------------------------------
 *
 * `applySnapshot`, `applyChanges` and `setCursor` are the WIRE-v1 write-in path:
 * the SocketHub folds a metadata batch and pushes it into the replica. On the
 * kernel path frames arrive as v2 and are applied by the kernel Replica through
 * its own transactional store, so those three methods have no correct
 * behaviour here — and the two plausible wrong ones are both silent. A no-op
 * would leave the engine rendering a frozen slice while the hub reported health;
 * a best-effort write would put a second writer on a store whose whole design is
 * one ordered writer. They THROW. A mis-wiring that hands this facade to a v1
 * hub is then a loud failure at the first frame instead of a slice that quietly
 * stops moving — the run's recurring defect class is instruments that cannot say
 * NO, and a facade that cannot say NO to the wrong wire is the same shape.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT ON THE KERNEL CACHE
 * ---------------------------------------------------------------------------
 *
 * ui-state, transcript windows and the outbox queue go to `SideCache` — see its
 * header for the reasoning on the first two. The OUTBOX is the load-bearing one:
 * the brief describes this facade as sitting over `{cache, outbox}`, and it does
 * not, on purpose. The kernel `OutboxStorePort` stores `OutboxRecord`s — a
 * dotted CONTRACT NAME and version, a delivery class, a partition key, an
 * attribution pair, a lifecycle state. The client `Outbox`'s entries are tRPC
 * mutation kinds. Bridging them means MINTING contract identity — inventing
 * `sessions.rename@1` and an attribution for a client that cannot yet name a
 * user — and writing it into a durable store, where POD-311's real contracts
 * would later disagree with records already on people's disks. The read-model
 * cutover this issue owns does not need it (the shadow basis §2.3 excludes
 * optimistic state from the comparison by design), so the write path stays where
 * it is and its cutover is filed separately rather than half-done here.
 *
 * ---------------------------------------------------------------------------
 * WHAT THAT SEPARATE CUTOVER DID (POD-1232) — READ THIS BEFORE TRUSTING THE ABOVE
 * ---------------------------------------------------------------------------
 *
 * The minting problem is gone: POD-311's contracts exist, and `OUTBOX_COMMANDS`
 * in `../../engine/wiring.ts` is the table that names each queued kind's real
 * contract and version, pinned to the contracts themselves by
 * `outbox-contract-table.test.ts`. So the ENGINE's queue is now the kernel's on
 * both platforms: web drove the kernel `Outbox` state machine over its IndexedDB
 * `OutboxStorePort` from POD-1232 (`openKernelEngineOutbox`), and POD-2073 put
 * mobile on the same driver over its SQLite one. Queued writes are in the same
 * transactional store as the entity rows (ADR 6 D4.3), with a dotted contract
 * name, a version, a delivery class, a partition key and an attribution pair
 * stamped from the AUTHENTICATED principal (ADR 3 D7) — never from anything the
 * entry carried.
 *
 * WHAT THIS FACADE'S THREE `outbox*Storage()` SEAMS ARE, THEREFORE: the side
 * cache, on both platforms, and NOT the engine's queue on either. Nothing on the
 * kernel path reads them. They are kept because the compatibility `Outbox` is
 * still the queue on the legacy replica, and they are NOT pointed at the kernel
 * store because that would put a second, mirror-backed writer on records the
 * kernel `Outbox` owns — and would lose POD-1231's synchronous "this write is
 * not durable" report, which only exists because `StorageApi.setItem` is
 * synchronous.
 *
 * Mobile used to be the exception: it passed a pair of `OutboxStorage` views
 * over its kernel outbox rows through an `init.outbox` seam here, which let the
 * compatibility state machine drive kernel-owned records. POD-2073 deleted both
 * the views and the seam. Named here so the next reader does not conclude from
 * `outboxStorage()` that either platform queues to a blob store — neither does.
 */

import type { TranscriptItem } from '@podium/model'
import type { EntityRecord, ExitKind, ReplicaEvent } from '@podium/sync/replica'
import type { OutboxStorage } from '../../outbox'
import type {
  Replica,
  ReplicaHydrateResult,
  ReplicaKind,
  ReplicaRows,
  TranscriptWindow,
  UiState,
} from '../contract'
import { COLD_CURSOR, type FeedCursor } from '../feed'
import { entityForKind, kindForEntity, rowKey } from './kinds'
import type { SideCache } from './side-cache'

/**
 * The cache, as this facade needs it: read-only.
 *
 * Narrower than `ReplicaCacheStore` on purpose. A facade that could `applyAtomic`
 * or `discardCache` would be a second writer on the kernel's store, and the
 * engine's read model has no business holding that. Structural typing means the
 * adapter's real view satisfies this without a second class.
 */
export interface KernelCacheRead {
  readCursor(): { readonly seq: number } | null
  readEntities(): readonly EntityRecord[]
  /**
   * One row, by the kernel's own identity. `ReplicaCacheStore` has carried this
   * read from the start; it is on THIS view because the projection below applies
   * events as deltas, and a delta path whose only read was `readEntities()`
   * would re-materialise every entity of every kind to learn about one row —
   * the exact O(store) walk the delta path exists to remove. Still read-only:
   * a narrower read is not a second writer.
   */
  read(entity: string, entityId: string): EntityRecord | undefined
  durability(): 'durable' | 'degraded-memory' | 'unavailable'
}

export interface KernelReplicaInit {
  readonly cache: KernelCacheRead
  readonly side: SideCache
  /**
   * The kernel Replica's OWN exit record, handed in rather than mirrored
   * (POD-1510).
   *
   * The facade could rebuild this from `onKernelEvent`: `removed`/`evicted` set
   * an entry, `upserted` clears it. It deliberately does not, and the reason is
   * that the kernel Replica's map is not a log of those three events — it is
   * ALSO cleared wholesale when a bootstrap is installed and when the cache is
   * discarded (`replica.ts`'s two `exits.clear()` sites), and readmission has a
   * defined meaning there (`readmitted`) that a shadow copy would have to
   * re-derive. A second map that agreed with the first on the common path and
   * disagreed after a heal is precisely the divergence this facade exists to
   * make impossible: two answers to "was it deleted or unshared?" is worse than
   * one honest `undefined`.
   *
   * OPTIONAL, so a composition root that has no kernel Replica in hand (the
   * facade's own tests, `replica-binding.test.ts`) still constructs, and answers
   * `undefined` — "no exit record", never a guess. The two real roots
   * (`apps/web/src/lib/kernelReplica.ts`, `apps/mobile`) construct the facade
   * BEFORE the kernel Replica, so this is a function they close over rather than
   * a value they could pass.
   */
  readonly exits?: (entity: string, entityId: string) => ExitKind | undefined
}

/** What the composition root drives, beyond the `Replica` interface itself. */
export interface KernelBackedReplica extends Replica {
  /**
   * Pipe the kernel Replica's `onEvent` here.
   *
   * The facade does not subscribe for itself: the kernel Replica takes ONE
   * `onEvent` callback at construction, and a facade that grabbed it would take
   * it away from whoever else needs it (the shadow harness does). The composition
   * root owns the fan-out; this is one of its outputs.
   */
  onKernelEvent(event: ReplicaEvent): void
}

/** The kinds a single event touches. `bootstrap-installed` and the cache-wide
 *  events touch every kind, because the whole slice was replaced.
 *
 *  The POD-796/POD-822 normalized kinds (`issueProjections`, `issueDeps`,
 *  `repos`) are IN this list even though `kinds.ts` maps no kernel entity to
 *  them yet: on this path they project empty, and a bootstrap that replaced the
 *  whole slice must still tell a listener on an empty kind that it re-read as
 *  empty. Leaving them out would make the notification set silently narrower
 *  than the interface, which is the harder bug to find later. */
const ALL_KINDS: readonly ReplicaKind[] = [
  'sessions',
  'issues',
  'issueProjections',
  'issueDeps',
  'repos',
  'issueEvents',
  'pendingInteractions',
  'shipOrders',
  'conversations',
  'automations',
  'automationRuns',
  'userLayouts',
]

/** Shared identity for an empty kind so engine snapshots do not churn
 *  pre-bootstrap (the same contract `rows()` has on the legacy path). */
const EMPTY: readonly never[] = Object.freeze([])

/**
 * One kind's materialised projection.
 *
 * `rows` is the array `rows()` hands out — sorted by `keyOf` ascending, and the
 * identity downstream memos key on. `byId` is the SAME row objects keyed by the
 * kernel's `entityId`, so a delta can find the row it replaces without walking
 * the store. entityId and not `rowKey`, deliberately: deltas arrive addressed by
 * the envelope's identity, and translating through the row VALUE would trust the
 * payload to agree with the envelope — the store keys on the envelope, so this
 * index must too.
 */
interface KindProjection {
  rows: readonly unknown[]
  readonly byId: Map<string, unknown>
}

export function createKernelReplica(init: KernelReplicaInit): KernelBackedReplica {
  const { cache, side } = init
  const listeners = new Map<ReplicaKind, Set<() => void>>()
  const batchListeners = new Set<(changed: ReadonlySet<ReplicaKind>) => void>()
  /**
   * The materialised per-kind projections, maintained INCREMENTALLY.
   *
   * The previous shape — clear the kind's memo on every event, rebuild from a
   * full `readEntities()` scan-and-sort on the next read — was measured in a live
   * client at ~628ms PER CHANGE (r² = 0.9997 over 228 envelopes): the memo was
   * cleared immediately before the synchronous drain that would have used it, so
   * "one projection per burst" was really one O(store) rescan per change. Here an
   * event applies as a DELTA to the kind it touched (`dirtyRows`, reconciled
   * lazily in `project`), and the full scan happens only when a kind has no
   * state at all — first read, and the wholesale replacements below.
   *
   * A kind whose CONTENTS did not change keeps the identical `rows` reference:
   * engine slices memoise on that identity (`worklist`'s `sourceEqual`), so
   * identity stability is part of the contract, not an optimisation.
   */
  const projected = new Map<ReplicaKind, KindProjection>()
  /** entityIds an event touched since the kind was last reconciled. The delta is
   *  RECORDED here and applied on the next read, so a burst that nobody reads —
   *  a rebootstrap's per-row replay — costs a set insert per event, not an array
   *  rebuild per event. */
  const dirtyRows = new Map<ReplicaKind, Set<string>>()
  /** Kinds touched since the outermost batch opened. */
  const pending = new Set<ReplicaKind>()
  let batchDepth = 0

  function touchRow(kind: ReplicaKind, entityId: string): void {
    let dirty = dirtyRows.get(kind)
    if (dirty === undefined) {
      dirty = new Set<string>()
      dirtyRows.set(kind, dirty)
    }
    dirty.add(entityId)
    pending.add(kind)
    if (batchDepth === 0) drain()
  }

  /** The whole slice was replaced: no delta describes that, so every kind's
   *  state is dropped and the next read rebuilds from one full scan. */
  function touchAllKinds(): void {
    projected.clear()
    dirtyRows.clear()
    for (const kind of ALL_KINDS) pending.add(kind)
    if (batchDepth === 0) drain()
  }

  function drain(): void {
    if (pending.size === 0) return
    const kinds = [...pending]
    pending.clear()
    for (const kind of kinds) {
      const set = listeners.get(kind)
      if (set === undefined) continue
      for (const cb of [...set]) {
        try {
          cb()
        } catch {
          // A listener that throws must not stop the others, and must not take
          // the frame's application down with it.
        }
      }
    }
    const changed = new Set(kinds)
    for (const cb of [...batchListeners]) {
      try {
        cb(changed)
      } catch {
        // A batch observer has the same isolation contract as row observers.
      }
    }
  }

  function project<K extends ReplicaKind>(kind: K): ReplicaRows[K][] {
    let state = projected.get(kind)
    if (state === undefined) {
      buildMissingProjections()
      state = projected.get(kind) as KindProjection
    } else {
      reconcile(kind, state)
    }
    return state.rows as ReplicaRows[K][]
  }

  /**
   * The full scan, for every kind that has no state — ONE `readEntities()` pass
   * shared across all of them, because materialising the store is the cost and
   * eleven kinds re-paying it after a bootstrap is eleven times the bill for one
   * answer. Kinds that already hold state are left alone: rebuilding a clean
   * kind would mint a new array identity for unchanged contents, which is the
   * memo churn the identity contract forbids.
   */
  function buildMissingProjections(): void {
    const building = new Map<ReplicaKind, Map<string, unknown>>()
    for (const kind of ALL_KINDS) {
      if (!projected.has(kind)) building.set(kind, new Map<string, unknown>())
    }
    let records: readonly EntityRecord[]
    try {
      records = cache.readEntities()
    } catch {
      // `rows()` never throws — a store that has gone unreadable reads as empty
      // here and the kernel Replica's own ladder is what heals it.
      records = EMPTY
    }
    for (const record of records) {
      const kind = kindForEntity(record.entity)
      if (kind === undefined) continue
      const byId = building.get(kind)
      if (byId === undefined) continue
      if (record.value === null || typeof record.value !== 'object') continue
      byId.set(record.entityId, record.value)
    }
    for (const [kind, byId] of building) {
      const rows = [...byId.values()]
      // Deterministic order, by the kernel's own key rather than by store
      // enumeration. The engine sorts everything it renders, so this is not a
      // display decision — it is what stops `rows()` from returning two different
      // permutations of one slice to the shadow comparison and to a memo.
      rows.sort((a, b) => (keyOf(kind, a as never) < keyOf(kind, b as never) ? -1 : 1))
      projected.set(kind, { rows: rows.length === 0 ? EMPTY : rows, byId })
      // A full read subsumes any recorded delta; leaving one behind would
      // re-apply it against state that already includes it.
      dirtyRows.delete(kind)
    }
  }

  /**
   * Apply the recorded deltas to one kind's materialised state.
   *
   * The CACHE is still the only source of row truth: each dirty id is re-read
   * through `cache.read`, never taken from the event that recorded it, so this
   * path cannot disagree with what a full rebuild would have produced — the
   * events only say WHICH rows to re-read. (An upsert-then-remove of one entity
   * inside one frame therefore lands absent on the first re-read, exactly as the
   * full scan would see it.)
   *
   * The new `rows` array is built as one linear merge — survivors in their
   * existing order, replacements and inserts merged in at their sorted position
   * — so the ordering `buildMissingProjections` establishes is preserved without
   * re-sorting the slice, and the work per drain is bounded by the touched
   * KIND's size, never the store's. When every delta turns out to be a no-op
   * (a remove for a row this view never held), the existing array is kept, so
   * identity-keyed memos see no change — because there was none.
   */
  function reconcile(kind: ReplicaKind, state: KindProjection): void {
    const dirty = dirtyRows.get(kind)
    if (dirty === undefined || dirty.size === 0) return
    dirtyRows.delete(kind)
    const entity = entityForKind(kind)
    const replaced = new Set<unknown>()
    const added: unknown[] = []
    for (const entityId of dirty) {
      const previous = state.byId.get(entityId)
      let next: unknown
      try {
        const record = cache.read(entity, entityId)
        // The same admission rule as the full scan: a value that is not an
        // object row is not rendered, whatever the event said.
        next =
          record !== undefined && record.value !== null && typeof record.value === 'object'
            ? record.value
            : undefined
      } catch {
        // Same never-throws contract as the full scan: unreadable reads as gone.
        next = undefined
      }
      if (next === previous) continue
      if (previous !== undefined) replaced.add(previous)
      if (next === undefined) {
        state.byId.delete(entityId)
      } else {
        state.byId.set(entityId, next)
        added.push(next)
      }
    }
    if (replaced.size === 0 && added.length === 0) return
    added.sort((a, b) => (keyOf(kind, a as never) < keyOf(kind, b as never) ? -1 : 1))
    const merged: unknown[] = []
    let take = 0
    for (const row of state.rows) {
      if (replaced.has(row)) continue
      const key = keyOf(kind, row as never)
      while (take < added.length && keyOf(kind, added[take] as never) < key) {
        merged.push(added[take])
        take += 1
      }
      merged.push(row)
    }
    while (take < added.length) {
      merged.push(added[take])
      take += 1
    }
    state.rows = merged.length === 0 ? EMPTY : merged
  }

  /** `rowKey` rather than a local copy of the sessions/`id` split: this feeds the
   *  sort above, and a kind whose identity this copy did not know would key every
   *  row on `undefined` — an unstable order, which is the one thing that sort
   *  exists to prevent. `kinds.ts` is where identity is total over the kinds. */
  function keyOf<K extends ReplicaKind>(kind: K, row: ReplicaRows[K]): string {
    return rowKey(kind, row)
  }

  function refuse(method: string): never {
    throw new Error(
      `Replica.${method}() is the wire-v1 write path and this replica is on the kernel feed. ` +
        'The kernel Replica applies frames through its own store; a second writer here would ' +
        'race it. This is a wiring error: the hub must be constructed with a feed sink, not ' +
        'with fetchChangesSince/onMetadataApplied.',
    )
  }

  const facade: KernelBackedReplica = {
    get persistent(): boolean {
      try {
        return cache.durability() === 'durable'
      } catch {
        return false
      }
    },

    async hydrate(): Promise<ReplicaHydrateResult> {
      // The kernel's storage adapter is already open by the time this facade is
      // constructed (the composition root awaits it), so hydration here is a
      // READ of what is already durable — which is exactly what preserves
      // cold-start paint: the first render reads the persisted slice.
      return {
        sessions: project('sessions'),
        issues: project('issues'),
        issueProjections: project('issueProjections'),
        issueDeps: project('issueDeps'),
        repos: project('repos'),
        issueEvents: project('issueEvents'),
        pendingInteractions: project('pendingInteractions'),
        shipOrders: project('shipOrders'),
        conversations: project('conversations'),
        automations: project('automations'),
        automationRuns: project('automationRuns'),
        userLayouts: project('userLayouts'),
        cursor: facade.getCursor(),
        feedCursor: facade.getFeedCursor(),
        // ADR 2 D7 rung 6 is the LEGACY blob's version check. This path has no
        // blob: the kernel store carries its own schema version and resets
        // itself before this facade is constructed, so a reset that happened is
        // already invisible here. Reporting `true` would be a claim we cannot
        // make, and reporting a reset we did not perform is worse than not
        // reporting one — the caller only uses it to explain empty lists.
        schemaReset: false,
      }
    },

    applySnapshot: () => refuse('applySnapshot'),
    applyChanges: () => refuse('applyChanges'),
    setCursor: () => refuse('setCursor'),
    setFeedCursor: () => refuse('setFeedCursor'),
    resetCache: () => refuse('resetCache'),
    collection: () =>
      refuse(
        'collection' +
          ' /* the TanStack live-query seam; the kernel path exposes rows()/subscribeRows() */',
      ),

    getCursor(): number | null {
      try {
        return cache.readCursor()?.seq ?? null
      } catch {
        return null
      }
    },

    getFeedCursor(): FeedCursor {
      // READ, so it answers rather than refusing — the shadow comparison and the
      // health surfaces call it on both replicas and a throw here would report
      // as a kernel fault. What it can honestly answer is the SEQ: the kernel's
      // cache view (`KernelCacheRead`) deliberately narrows to `{ seq }`, and the
      // feed IDENTITY lives with the kernel Replica's own ladder, not in this
      // read model. `feedId`/`epoch` are therefore null — the same spelling
      // `COLD_CURSOR` uses for "identity not established here", never a made-up
      // id that an identity check downstream would compare against and trust.
      const seq = facade.getCursor()
      return seq === null ? COLD_CURSOR : { ...COLD_CURSOR, seq }
    },

    transcriptWindow(conversationKey: string): TranscriptWindow | undefined {
      return side.transcriptWindow(conversationKey)
    },
    putTranscriptWindow(conversationKey: string, items: TranscriptItem[]): void {
      side.putTranscriptWindow(conversationKey, items)
    },

    rows<K extends ReplicaKind>(kind: K): ReplicaRows[K][] {
      return project(kind)
    },

    exitKind(entity: string, entityId: string): ExitKind | undefined {
      // A READ, so it answers rather than refusing, and it never throws: this is
      // called from render, and a replica that made a page crash because it
      // could not say WHY a row was gone would be worse than one that said
      // nothing. `undefined` from the catch means the same as `undefined` from
      // an unwired port — no exit record — which `resolveReferent` renders as
      // `pending`, i.e. as no claim at all.
      const port = init.exits
      if (port === undefined) return undefined
      try {
        return port(entity, entityId)
      } catch {
        return undefined
      }
    },

    subscribeRows(kind: ReplicaKind, cb: () => void): () => void {
      const set = listeners.get(kind) ?? new Set<() => void>()
      listeners.set(kind, set)
      set.add(cb)
      return () => set.delete(cb)
    },

    subscribeRowBatch(cb: (changed: ReadonlySet<ReplicaKind>) => void): () => void {
      batchListeners.add(cb)
      return () => batchListeners.delete(cb)
    },

    batch<T>(fn: () => T): T {
      batchDepth += 1
      try {
        return fn()
      } finally {
        batchDepth -= 1
        if (batchDepth === 0) drain()
      }
    },

    // The side cache, unconditionally — see the header. These are the legacy
    // `Outbox`'s three homes; the kernel queue both platforms now run reaches
    // its records through `OutboxStorePort` and never through here.
    outboxStorage: (): OutboxStorage => side.outboxStorage(),
    outboxAwaitingStorage: (): OutboxStorage => side.outboxAwaitingStorage(),
    outboxDeadLetterStorage: (): OutboxStorage => side.outboxDeadLetterStorage(),
    uiState: (): UiState => side.uiState(),

    async flush(): Promise<void> {
      // Entity durability is the kernel store's own commit, awaited by whoever
      // drove the frame; the side cache is synchronous. Nothing is buffered here.
    },

    onKernelEvent(event: ReplicaEvent): void {
      switch (event.type) {
        case 'upserted': {
          const kind = kindForEntity(event.record.entity)
          if (kind !== undefined) touchRow(kind, event.record.entityId)
          return
        }
        case 'removed':
        case 'evicted': {
          // Both leave this slice, and `rows()` renders both as gone, so THIS
          // projection does not branch — a row that has left the view is absent
          // either way.
          //
          // The DIFFERENCE is not lost by that: it is answered by `exitKind()`
          // above, off the kernel Replica's own exit record, which is the seam a
          // surface that must render "unshared" differently from "deleted" reads
          // (POD-1510). Collapsing it HERE and preserving it THERE is the whole
          // arrangement — do not "fix" this case by branching, and do not read
          // this comment as licence to collapse the two anywhere else.
          const kind = kindForEntity(event.entity)
          if (kind !== undefined) touchRow(kind, event.entityId)
          return
        }
        case 'bootstrap-installed':
          touchAllKinds()
          return
        default:
          // `cursor`, `posture`, `heal`, `bootstrap-failed` do not change the
          // rows. A watermark-only stretch must leave the rendered slice
          // BYTE-IDENTICAL (basis matrix case 6), and notifying here is how that
          // property would be lost.
          return
      }
    },
  }

  return facade
}
