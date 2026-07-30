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
 */

import type { CacheMutation, ReplicaCacheStore } from './ports'
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

export class InMemoryOutbox {
  private entries: OutboxEntry[] = []

  enqueue(entry: OutboxEntry): void {
    this.entries.push(entry)
  }

  list(): readonly OutboxEntry[] {
    return [...this.entries]
  }

  retire(mutationId: string): void {
    this.entries = this.entries.filter((e) => e.mutationId !== mutationId)
  }
}

class InMemoryCache implements ReplicaCacheStore {
  private rows = new Map<string, EntityRecord>()
  private cursorValue: Cursor | null = null
  /** Flipped by tests to exercise D7 rung 5 / ADR 6 D4.5. */
  corrupt = false
  mode: 'durable' | 'degraded-memory' | 'unavailable' = 'degraded-memory'
  /** How many transactions were committed. Proves batching, not a stat for production. */
  transactions = 0

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

  applyAtomic(mutation: CacheMutation): void {
    this.guard()
    // Build the post-state first and swap once: a throw part-way through leaves
    // the pre-operation snapshot, never a torn mix (ADR 6 D4.1).
    const next = new Map(this.rows)
    applyInto(next, mutation)
    this.rows = next
    if (mutation.cursor !== undefined) this.cursorValue = mutation.cursor
    this.transactions += 1
  }

  installSnapshot(
    rows: readonly EntityRecord[],
    cursor: Cursor,
    buffered: readonly CacheMutation[],
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
    this.rows = next
    this.cursorValue = head
    this.transactions += 1
  }

  discardCache(): void {
    this.guard()
    // Reaches entities and the cursor. There is no outbox here to reach.
    this.rows = new Map()
    this.cursorValue = null
    this.transactions += 1
  }

  durability(): 'durable' | 'degraded-memory' | 'unavailable' {
    return this.corrupt ? 'unavailable' : this.mode
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

/**
 * One physical store holding both regions (ADR 6 D4.1), handing out two ports.
 * The Replica gets `.cache`; the outbox owner (POD-370) gets `.outbox`.
 */
export class InMemoryReplicaStore {
  readonly cache = new InMemoryCache()
  readonly outbox = new InMemoryOutbox()

  /** Simulate ADR 6 D4.5 corruption / D7 rung 5. */
  setCorrupt(corrupt: boolean): void {
    this.cache.corrupt = corrupt
  }

  get transactions(): number {
    return this.cache.transactions
  }
}
