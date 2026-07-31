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
 */

import type { TranscriptItem } from '@podium/model'
import type { EntityRecord, ReplicaEvent } from '@podium/sync/replica'
import type { OutboxStorage } from '../../outbox'
import type {
  Replica,
  ReplicaHydrateResult,
  ReplicaKind,
  ReplicaRows,
  TranscriptWindow,
  UiState,
} from '../contract'
import { kindForEntity } from './kinds'
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
  durability(): 'durable' | 'degraded-memory' | 'unavailable'
}

export interface KernelReplicaInit {
  readonly cache: KernelCacheRead
  readonly side: SideCache
  /**
   * The outbox's durable home, when it is NOT the side cache.
   *
   * ADR 6 D1 names outbox entries among what localStorage/AsyncStorage MUST NOT
   * hold "on any path". The side cache is a `StorageApi` blob store, so it
   * satisfies D1 for ui-state and transcripts and NOT for the outbox. Mobile
   * passes its SQLite store view here and lands the queue in the entity rows'
   * own transaction domain; web needs its own compliant seam and keeps the side
   * cache only until it has one.
   *
   * OPTIONAL, and defaulting to the side cache, DELIBERATELY: making it required
   * would have changed web's behaviour in the same commit that gave mobile a
   * correct placement, and a cutover that changes two things at once cannot be
   * bisected when one of them is wrong.
   */
  readonly outbox?: { readonly queued: OutboxStorage; readonly awaiting: OutboxStorage }
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
 *  events touch every kind, because the whole slice was replaced. */
const ALL_KINDS: readonly ReplicaKind[] = [
  'sessions',
  'issues',
  'conversations',
  'automations',
  'automationRuns',
]

/** Shared identity for an empty kind so engine snapshots do not churn
 *  pre-bootstrap (the same contract `rows()` has on the legacy path). */
const EMPTY: readonly never[] = Object.freeze([])

export function createKernelReplica(init: KernelReplicaInit): KernelBackedReplica {
  const { cache, side } = init
  const listeners = new Map<ReplicaKind, Set<() => void>>()
  /** Cleared per kind when an event touched it; `rows()` re-projects lazily so a
   *  burst of frames costs one projection, not one per frame. */
  const projected = new Map<ReplicaKind, readonly unknown[]>()
  /** Kinds touched since the outermost batch opened. */
  const pending = new Set<ReplicaKind>()
  let batchDepth = 0

  function touch(kinds: readonly ReplicaKind[]): void {
    for (const kind of kinds) {
      projected.delete(kind)
      pending.add(kind)
    }
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
  }

  function project<K extends ReplicaKind>(kind: K): ReplicaRows[K][] {
    const cached = projected.get(kind)
    if (cached !== undefined) return cached as ReplicaRows[K][]
    let records: readonly EntityRecord[]
    try {
      records = cache.readEntities()
    } catch {
      // `rows()` never throws — a store that has gone unreadable reads as empty
      // here and the kernel Replica's own ladder is what heals it.
      records = EMPTY
    }
    const rows: ReplicaRows[K][] = []
    for (const record of records) {
      if (kindForEntity(record.entity) !== kind) continue
      if (record.value === null || typeof record.value !== 'object') continue
      rows.push(record.value as ReplicaRows[K])
    }
    // Deterministic order, by the kernel's own key rather than by store
    // enumeration. The engine sorts everything it renders, so this is not a
    // display decision — it is what stops `rows()` from returning two different
    // permutations of one slice to the shadow comparison and to a memo.
    rows.sort((a, b) => (keyOf(kind, a) < keyOf(kind, b) ? -1 : 1))
    const frozen = rows.length === 0 ? (EMPTY as unknown as ReplicaRows[K][]) : rows
    projected.set(kind, frozen)
    return frozen
  }

  function keyOf<K extends ReplicaKind>(kind: K, row: ReplicaRows[K]): string {
    return kind === 'sessions'
      ? (row as ReplicaRows['sessions']).sessionId
      : (row as ReplicaRows['issues']).id
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
        conversations: project('conversations'),
        automations: project('automations'),
        automationRuns: project('automationRuns'),
        cursor: facade.getCursor(),
      }
    },

    applySnapshot: () => refuse('applySnapshot'),
    applyChanges: () => refuse('applyChanges'),
    setCursor: () => refuse('setCursor'),
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

    transcriptWindow(conversationKey: string): TranscriptWindow | undefined {
      return side.transcriptWindow(conversationKey)
    },
    putTranscriptWindow(conversationKey: string, items: TranscriptItem[]): void {
      side.putTranscriptWindow(conversationKey, items)
    },

    rows<K extends ReplicaKind>(kind: K): ReplicaRows[K][] {
      return project(kind)
    },

    subscribeRows(kind: ReplicaKind, cb: () => void): () => void {
      const set = listeners.get(kind) ?? new Set<() => void>()
      listeners.set(kind, set)
      set.add(cb)
      return () => set.delete(cb)
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

    outboxStorage: (): OutboxStorage => init.outbox?.queued ?? side.outboxStorage(),
    outboxAwaitingStorage: (): OutboxStorage =>
      init.outbox?.awaiting ?? side.outboxAwaitingStorage(),
    uiState: (): UiState => side.uiState(),

    async flush(): Promise<void> {
      // Entity durability is the kernel store's own commit, awaited by whoever
      // drove the frame; the side cache is synchronous. Nothing is buffered here.
    },

    onKernelEvent(event: ReplicaEvent): void {
      switch (event.type) {
        case 'upserted': {
          const kind = kindForEntity(event.record.entity)
          if (kind !== undefined) touch([kind])
          return
        }
        case 'removed':
        case 'evicted': {
          // Both leave this slice, and the read model renders both as gone. The
          // DIFFERENCE between them is real and preserved — the kernel Replica's
          // `exitKind()` still distinguishes them, and the shadow classifier
          // reads it there — but a row that has left the view is absent from
          // `rows()` either way, so this projection does not need to branch.
          const kind = kindForEntity(event.entity)
          if (kind !== undefined) touch([kind])
          return
        }
        case 'bootstrap-installed':
          touch(ALL_KINDS)
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
