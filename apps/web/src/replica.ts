/**
 * Thin-client replica (docs/spec/thin-client-replica.md, P6a): a PERSISTENT
 * local mirror of the durable entities (sessions / issues / conversations),
 * the metadata-oplog cursor, and bounded per-conversation transcript windows,
 * so a reload — or opening the PWA offline — paints from local data instead of
 * a blank shell.
 *
 * ALL TanStack DB APIs live behind this one adapter module (spec §2.1): call
 * sites and tests speak the `Replica` interface below, so an API-churn upgrade
 * or a React Native port touches one file.
 *
 * PERSISTENCE CHOICE (spec §2.1 delegates this to the adapter): TanStack DB's
 * built-in `localStorageCollectionOptions` (@tanstack/db 0.6.x). Rationale:
 * - There is no published SQLite-wasm persister for @tanstack/db today; the
 *   library's shipped persistence options are localStorage/sessionStorage
 *   collections (JSON blob per collection + cross-tab `storage` events).
 * - The PWA's replica payload is small (metadata rows + ≤50 bounded transcript
 *   windows — "phones, not archives"), well inside localStorage quotas, and a
 *   wasm persister would blow the ~1.5MB precache budget (spec §4) on its own.
 * - localStorage is synchronous, which makes the cursor-after-data invariant
 *   (spec invariant 3) easy to uphold: `setCursor` chains behind the last data
 *   write's persistence promise before touching storage.
 * - The lib already cold-starts on corrupt blobs (its loader swallows and
 *   returns empty — spec invariant 2). When localStorage is unusable (private
 *   mode / quota) we probe up front and run the SAME collections over an
 *   in-memory storage adapter — one code path, persistence becomes best-effort
 *   (`persistent` is false; a reload cold-starts, spec invariant 4).
 * An IndexedDB/SQLite persister can later replace this behind the same
 * interface. Follow-on: per-delta persistence rewrites each touched collection
 * blob whole (inherent to a JSON-blob backing); acceptable at current sizes.
 */

import type {
  ConversationSummaryWire,
  IssueWire,
  SessionMeta,
  TranscriptItem,
} from '@podium/protocol'
import type { Collection, StorageApi, StorageEventApi, Transaction } from '@tanstack/db'
import { createCollection, localStorageCollectionOptions } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import {
  parseOutboxEntries,
  type OutboxEntry,
  type OutboxStorage,
} from '@podium/client-core/outbox'
import { OUTBOX_LS_KEY } from './outbox'

/** Wire row type per replica collection kind. */
export interface ReplicaRows {
  sessions: SessionMeta
  issues: IssueWire
  conversations: ConversationSummaryWire
}
export type ReplicaKind = keyof ReplicaRows

export interface ReplicaHydrateResult {
  sessions: SessionMeta[]
  issues: IssueWire[]
  conversations: ConversationSummaryWire[]
  /** Last persisted oplog cursor, or null when never synced (cold client). */
  cursor: number | null
}

/** A cached transcript window: the newest items read for one conversation. */
export interface TranscriptWindow {
  items: TranscriptItem[]
  /** Epoch ms when the window was written — drives the "as of <time>" notice. */
  savedAt: number
}

export interface Replica {
  /** False when durable storage is unusable (private mode, quota). The replica
   *  still WORKS — the same collections, live queries, and outbox run over an
   *  in-memory storage adapter behind the same seam — it just forgets on
   *  reload, like the old in-memory client. There is no parallel code path. */
  readonly persistent: boolean
  /** Load everything persisted. NEVER throws — a poisoned replica clears
   *  itself and resolves as a cold client (spec invariant 2). */
  hydrate(): Promise<ReplicaHydrateResult>
  /** Full-list replace for one kind (snapshot semantics: rows not present are
   *  removed). Rows that are byte-identical to what's stored are not rewritten. */
  applySnapshot<K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][]): void
  /** Delta semantics: upsert + remove by id. Idempotent. */
  applyChanges<K extends ReplicaKind>(kind: K, upserts: ReplicaRows[K][], removeIds: string[]): void
  getCursor(): number | null
  /** Persist the cursor AFTER the entity writes issued before this call have
   *  landed (spec invariant 3) — a crash between = idempotent re-apply, never a gap. */
  setCursor(cursor: number): void
  /** The cached newest window for a conversation key, if any. */
  transcriptWindow(conversationKey: string): TranscriptWindow | undefined
  /** Write-through cache of a fresh read. Bounded per spec §2.3: the newest
   *  REPLICA_TRANSCRIPT_ITEM_CAP items, LRU-capped at
   *  REPLICA_TRANSCRIPT_CONVERSATION_CAP conversations. */
  putTranscriptWindow(conversationKey: string, items: TranscriptItem[]): void
  /** The underlying entity collection for `kind` — the live-query seam consumed
   *  ONLY by `useReplicaRows` below (typed `unknown` so no TanStack type leaks
   *  through the interface). */
  collection(kind: ReplicaKind): unknown
  /** P6b outbox consolidation: an `OutboxStorage` backed by a replica collection
   *  (`<prefix>.outbox.v1`), so the offline queue shares the ONE persistence
   *  layer and gets cross-tab consistency from the lib's `storage` events. The
   *  legacy `podium.outbox.v1` JSON blob is migrated in on first use. In
   *  private mode the queue lives in the in-memory storage — it drains while
   *  the tab lives and is lost on reload (best-effort, like everything else). */
  outboxStorage(): OutboxStorage
}

/** Spec §2.3: "last ~200 items per conversation, LRU cap ~50 conversations". */
export const REPLICA_TRANSCRIPT_ITEM_CAP = 200
export const REPLICA_TRANSCRIPT_CONVERSATION_CAP = 50

export const REPLICA_KEY_PREFIX = 'podium.replica'

export interface ReplicaInit {
  /** Storage seam (mirrors outbox.ts): tests inject a fake; defaults to window.localStorage. */
  storage?: StorageApi
  /** Cross-tab sync events; defaults to window. Tests usually omit both. */
  storageEventApi?: StorageEventApi
  /** Key namespace, `podium.replica` by default (keys get `.<kind>.v1` suffixes). */
  keyPrefix?: string
  /** Clock seam for LRU tests. */
  now?: () => number
}

interface TranscriptRow {
  key: string
  savedAt: number
  items: TranscriptItem[]
}

/** Persisted outbox entry (P6b): the OutboxEntry plus a stable FIFO ordinal. */
type OutboxRow = OutboxEntry & { seq: number }

function maxSeq(rows: OutboxRow[]): number {
  let max = -1
  for (const r of rows) if (typeof r.seq === 'number' && r.seq > max) max = r.seq
  return max
}

/** In-place full replace of a draft's contents with `value` (update drafts are
 *  proxies over the stored object; leftover stale fields must be deleted). */
function replaceContents(draft: Record<string, unknown>, value: Record<string, unknown>): void {
  for (const k of Object.keys(draft)) {
    if (!(k in value)) delete draft[k]
  }
  Object.assign(draft, value)
}

/** Collections are identified globally by id; give each adapter instance a
 *  unique id (same storageKey) so tests can build several without colliding. */
let instanceSeq = 0

/** Map-backed StorageApi for the private-mode fallback — same seam, no DOM. */
function memoryStorage(): StorageApi {
  const data = new Map<string, string>()
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const NOOP_STORAGE_EVENTS: StorageEventApi = {
  addEventListener: () => {},
  removeEventListener: () => {},
}

class TanstackReplica implements Replica {
  readonly persistent: boolean
  private readonly storage: StorageApi
  private readonly storageEventApi: StorageEventApi
  private readonly prefix: string
  private readonly nonce: number
  private readonly cursorKey: string
  private readonly now: () => number
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous collection map, typed at the access sites
  private readonly cols: Record<ReplicaKind | 'transcripts', any>
  /** Lazily-built outbox backing (P6b) — separate from `cols` so a poisoned
   *  entity replica's clearAll never wipes queued writes. */
  private outboxBacking: OutboxStorage | undefined
  /** Settles when every entity write issued so far has persisted — the fence
   *  `setCursor` waits behind (spec invariant 3). */
  private lastWrite: Promise<unknown> = Promise.resolve()

  constructor(init: ReplicaInit = {}) {
    const prefix = init.keyPrefix ?? REPLICA_KEY_PREFIX
    this.prefix = prefix
    this.cursorKey = `${prefix}.cursor.v1`
    this.now = init.now ?? Date.now
    const storage =
      init.storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
    this.persistent = probeStorage(storage)
    // Unusable storage (private mode / quota / SSR) → the SAME collections run
    // over an in-memory adapter: everything works, nothing survives a reload.
    this.storage = this.persistent && storage ? storage : memoryStorage()
    // Cross-tab wiring only when we're really on a shared window.localStorage.
    this.storageEventApi = this.persistent
      ? (init.storageEventApi ??
        (init.storage === undefined && typeof window !== 'undefined'
          ? window
          : NOOP_STORAGE_EVENTS))
      : NOOP_STORAGE_EVENTS
    this.nonce = ++instanceSeq
    this.cols = {
      sessions: this.makeCollection<SessionMeta>('sessions', (s) => s.sessionId),
      issues: this.makeCollection<IssueWire>('issues', (i) => i.id),
      conversations: this.makeCollection<ConversationSummaryWire>('conversations', (c) => c.id),
      transcripts: this.makeCollection<TranscriptRow>('transcripts', (t) => t.key),
    }
    // Keep the collections' sync alive for the app's lifetime: a permanent
    // no-op subscriber prevents the no-subscriber GC from dropping state
    // between the store's hydrate and ChatView's cache reads.
    for (const col of Object.values(this.cols)) {
      try {
        col.subscribeChanges(() => {})
      } catch {
        // never let replica plumbing break boot
      }
    }
  }

  async hydrate(): Promise<ReplicaHydrateResult> {
    const empty: ReplicaHydrateResult = {
      sessions: [],
      issues: [],
      conversations: [],
      cursor: null,
    }
    try {
      await Promise.all(Object.values(this.cols).map((c) => c.preload()))
      return {
        sessions: this.cols.sessions.toArray as SessionMeta[],
        issues: this.cols.issues.toArray as IssueWire[],
        conversations: this.cols.conversations.toArray as ConversationSummaryWire[],
        cursor: this.getCursor(),
      }
    } catch (err) {
      // Poisoned replica: clear and cold-start rather than wedge boot (invariant 2).
      console.warn('[podium] replica hydrate failed — clearing and cold-starting', err)
      this.clearAll()
      return empty
    }
  }

  applySnapshot<K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][]): void {
    try {
      const col = this.cols[kind]
      const keyOf = this.keyFor(kind)
      const next = new Set(rows.map((r) => keyOf(r)))
      const stale = (col.toArray as ReplicaRows[K][])
        .map((r) => keyOf(r))
        .filter((k) => !next.has(k))
      if (stale.length > 0) this.track(col.delete(stale))
      this.upsertRows(kind, rows)
    } catch (err) {
      console.warn(`[podium] replica applySnapshot(${kind}) failed`, err)
    }
  }

  applyChanges<K extends ReplicaKind>(
    kind: K,
    upserts: ReplicaRows[K][],
    removeIds: string[],
  ): void {
    try {
      const col = this.cols[kind]
      const present = removeIds.filter((id) => col.has(id))
      if (present.length > 0) this.track(col.delete(present))
      this.upsertRows(kind, upserts)
    } catch (err) {
      console.warn(`[podium] replica applyChanges(${kind}) failed`, err)
    }
  }

  getCursor(): number | null {
    try {
      const raw = this.storage.getItem(this.cursorKey)
      if (raw === null) return null
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }

  setCursor(cursor: number): void {
    // Persist-after-data: wait for every entity write issued before this call.
    const fence = this.lastWrite
    void fence.then(() => {
      try {
        this.storage.setItem(this.cursorKey, String(cursor))
      } catch {
        // best-effort — a missing cursor just means a snapshot next boot
      }
    })
  }

  transcriptWindow(conversationKey: string): TranscriptWindow | undefined {
    try {
      const row = this.cols.transcripts.get(conversationKey) as TranscriptRow | undefined
      return row ? { items: row.items, savedAt: row.savedAt } : undefined
    } catch {
      return undefined
    }
  }

  putTranscriptWindow(conversationKey: string, items: TranscriptItem[]): void {
    try {
      const col = this.cols.transcripts
      const row: TranscriptRow = {
        key: conversationKey,
        savedAt: this.now(),
        items: items.slice(-REPLICA_TRANSCRIPT_ITEM_CAP),
      }
      if (col.has(conversationKey)) {
        this.track(
          col.update(conversationKey, (draft: Record<string, unknown>) =>
            replaceContents(draft, row as unknown as Record<string, unknown>),
          ),
        )
      } else {
        this.track(col.insert(row))
      }
      // LRU cap: evict the least-recently-written conversations beyond the cap.
      const all = col.toArray as TranscriptRow[]
      if (all.length > REPLICA_TRANSCRIPT_CONVERSATION_CAP) {
        const evict = [...all]
          .sort((a, b) => a.savedAt - b.savedAt)
          .slice(0, all.length - REPLICA_TRANSCRIPT_CONVERSATION_CAP)
          .map((r) => r.key)
        this.track(col.delete(evict))
      }
    } catch (err) {
      console.warn('[podium] replica putTranscriptWindow failed', err)
    }
  }

  collection(kind: ReplicaKind): unknown {
    return this.cols[kind]
  }

  outboxStorage(): OutboxStorage {
    if (this.outboxBacking) return this.outboxBacking
    const col = this.makeCollection<OutboxRow>('outbox', (r) => r.mutationId)
    try {
      // Permanent no-op subscriber: starts the collection's (synchronous)
      // localStorage sync and keeps it from being GC'd between accesses.
      col.subscribeChanges(() => {})
      // One-time migration: fold any legacy podium.outbox.v1 JSON blob into the
      // collection (append entries not already present, FIFO after what's here),
      // then retire the legacy key — entries are never dropped silently.
      const legacy = parseOutboxEntries(this.storage.getItem(OUTBOX_LS_KEY))
      if (legacy.length > 0) {
        const have = new Set((col.toArray as OutboxRow[]).map((r) => r.mutationId))
        let seq = maxSeq(col.toArray as OutboxRow[])
        const missing = legacy
          .filter((e) => !have.has(e.mutationId))
          .map((e) => ({ ...e, seq: ++seq }))
        if (missing.length > 0) this.track(col.insert(missing))
        this.storage.removeItem(OUTBOX_LS_KEY)
      }
    } catch (err) {
      console.warn('[podium] replica outbox migration failed', err)
    }
    this.outboxBacking = {
      // `seq` is assigned once at first sight and never rewritten, so ordering
      // survives reloads and front-of-queue drops without churning rows.
      load: () => {
        try {
          return (
            (col.toArray as OutboxRow[])
              .filter(
                (r) =>
                  typeof r.mutationId === 'string' &&
                  typeof r.kind === 'string' &&
                  typeof r.queuedAt === 'number',
              )
              .sort((a, b) => a.seq - b.seq || a.queuedAt - b.queuedAt)
              // Explicit reconstruction: synced rows carry the lib's $-metadata
              // props (and our seq) — hand the outbox exactly its own shape.
              .map((r) => ({
                mutationId: r.mutationId,
                kind: r.kind,
                input: r.input,
                queuedAt: r.queuedAt,
              }))
          )
        } catch {
          return []
        }
      },
      save: (entries) => {
        try {
          const existing = new Map((col.toArray as OutboxRow[]).map((r) => [r.mutationId, r]))
          const keep = new Set(entries.map((e) => e.mutationId))
          const stale = [...existing.keys()].filter((id) => !keep.has(id))
          if (stale.length > 0) this.track(col.delete(stale))
          let seq = maxSeq([...existing.values()])
          // The queue only pushes at the back and shifts from the front, so the
          // new (unseen) entries arrive in FIFO order — ascending seq matches it.
          const inserts = entries
            .filter((e) => !existing.has(e.mutationId))
            .map((e) => ({ ...e, seq: ++seq }))
          if (inserts.length > 0) this.track(col.insert(inserts))
        } catch (err) {
          console.warn('[podium] replica outbox save failed', err)
        }
      },
    }
    return this.outboxBacking
  }

  // ---- internals ----

  private makeCollection<T extends object>(kind: string, getKey: (row: T) => string) {
    return createCollection(
      localStorageCollectionOptions<T, string>({
        // Collections are identified globally by id; the per-instance nonce lets
        // tests build several adapters over the same storageKey without colliding.
        id: `${this.prefix}.${kind}#${this.nonce}`,
        storageKey: `${this.prefix}.${kind}.v1`,
        storage: this.storage,
        storageEventApi: this.storageEventApi,
        getKey,
      }),
    )
  }

  private keyFor<K extends ReplicaKind>(kind: K): (row: ReplicaRows[K]) => string {
    return kind === 'sessions'
      ? (row) => (row as SessionMeta).sessionId
      : (row) => (row as IssueWire | ConversationSummaryWire).id
  }

  /** Insert-new + update-changed (skipping byte-identical rows so a re-applied
   *  snapshot is write-free). Batched: one transaction per operation type. */
  private upsertRows<K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][]): void {
    const col = this.cols[kind]
    const keyOf = this.keyFor(kind)
    const inserts: ReplicaRows[K][] = []
    const updates: Array<{ key: string; row: ReplicaRows[K] }> = []
    for (const row of rows) {
      const key = keyOf(row)
      const existing = col.get(key) as ReplicaRows[K] | undefined
      if (existing === undefined) inserts.push(row)
      else if (JSON.stringify(existing) !== JSON.stringify(row)) updates.push({ key, row })
    }
    if (inserts.length > 0) this.track(col.insert(inserts))
    if (updates.length > 0) {
      this.track(
        col.update(
          updates.map((u) => u.key),
          (drafts: Record<string, unknown>[]) => {
            drafts.forEach((draft, i) => {
              const u = updates[i]
              if (u) replaceContents(draft, u.row as unknown as Record<string, unknown>)
            })
          },
        ),
      )
    }
  }

  /** Fold a write transaction into the persistence fence `setCursor` awaits. */
  private track(tx: Transaction): void {
    const settled = tx.isPersisted.promise.catch(() => {})
    this.lastWrite = Promise.all([this.lastWrite, settled])
  }

  private clearAll(): void {
    try {
      for (const col of Object.values(this.cols)) col.utils.clearStorage()
      this.storage.removeItem(this.cursorKey)
    } catch {
      // clearing is best-effort; the in-memory state is already empty
    }
  }
}

/** True when the storage accepts a write (private mode / quota-exhausted throws). */
function probeStorage(storage: StorageApi | undefined): boolean {
  if (!storage) return false
  try {
    const probe = `${REPLICA_KEY_PREFIX}.__probe__`
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

export function createReplica(init: ReplicaInit = {}): Replica {
  return new TanstackReplica(init)
}

/**
 * React live-query over one replica collection: the rows re-render on every
 * collection change — the store derives its entity arrays from this instead of
 * mirroring hub events into useState. The replica is ALWAYS live (in-memory in
 * private browsing), so this is the one entity read path. Lives here so ALL
 * TanStack APIs (including the React binding) stay behind the one adapter
 * module (spec §2.1).
 */
const EMPTY_ROWS: never[] = []

export function useReplicaRows<K extends ReplicaKind>(
  replica: Replica,
  kind: K,
): ReplicaRows[K][] {
  const { data } = useLiveQuery(
    () =>
      // biome-ignore lint/suspicious/noExplicitAny: adapter-internal cast from the untyped collection seam
      replica.collection(kind) as Collection<ReplicaRows[K], string, any>,
    [replica, kind],
  )
  // Stable empty identity so downstream memos don't churn pre-hydrate.
  return data === undefined || data.length === 0 ? EMPTY_ROWS : (data as ReplicaRows[K][])
}
