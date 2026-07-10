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
import type { StorageApi, StorageEventApi, Transaction } from '@tanstack/db'
import { createCollection, localStorageCollectionOptions } from '@tanstack/db'
import { OUTBOX_LS_KEY, type OutboxEntry, type OutboxStorage, parseOutboxEntries } from '../outbox'

export type { StorageApi, StorageEventApi }

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
  /** Non-React read seam (#262 [spec:SP-3fe2]): the current rows for `kind`.
   *  Returns a stable shared empty array while the collection is empty so
   *  engine snapshots don't churn pre-hydrate. Never throws. */
  rows<K extends ReplicaKind>(kind: K): ReplicaRows[K][]
  /** Non-React change seam (#262): fires on any change to `kind`'s collection
   *  (including cross-tab storage events) — the engine re-reads `rows()` then.
   *  Notifications are COALESCED per application (#262 review): applySnapshot /
   *  applyChanges each run their delete+upsert transactions as one unit, so a
   *  listener never observes the transient half-applied list between them.
   *  Returns the unsubscribe function. Never throws. */
  subscribeRows(kind: ReplicaKind, cb: () => void): () => void
  /** Coalesce `subscribeRows` notifications across every write issued inside
   *  `fn` (#262 review, nestable): listeners fire at most once per touched kind,
   *  AFTER the outermost batch completed — i.e. against the FINAL state. Used by
   *  the hub wiring to make a whole metadata application (bootstrap snapshot,
   *  heal snapshot, live delta — three kinds) atomic from the engine reactions'
   *  viewpoint. applySnapshot / applyChanges / hydrate already batch internally. */
  batch<T>(fn: () => T): T
  /** P6b outbox consolidation: an `OutboxStorage` backed by a replica collection
   *  (`<prefix>.outbox.v1`), so the offline queue shares the ONE persistence
   *  layer and gets cross-tab consistency from the lib's `storage` events. The
   *  legacy `podium.outbox.v1` JSON blob is migrated in on first use. In
   *  private mode the queue lives in the in-memory storage — it drains while
   *  the tab lives and is lost on reload (best-effort, like everything else). */
  outboxStorage(): OutboxStorage
  /** Separate durable home for the outbox's awaiting-truth stage (#263 review
   *  round 2): `<prefix>.outbox-awaiting.v1`, a collection OLD builds never
   *  read — a downgraded client (PWA cache rollback) loading the queued
   *  collection can't re-drain held entries as queued mutations. */
  outboxAwaitingStorage(): OutboxStorage
  /** ONE UI persistence mechanism (issue #15 Phase 4): a versioned key→value
   *  collection (`<prefix>.uistate.v1`) replacing the ad-hoc localStorage keys.
   *  Known legacy keys are migrated in once and the old keys removed. */
  uiState(): UiState
}

/** Synchronous UI-state kv over the ui-state collection. Never throws. */
export interface UiState {
  get(key: string): string | null
  /** `null` deletes the key. */
  set(key: string, value: string | null): void
  /** Fires on any ui-state change (including cross-tab storage events). */
  subscribe(cb: () => void): () => void
}

/** Exact legacy localStorage keys folded into the ui-state collection. */
export const LEGACY_UI_KEYS = [
  'podium.view',
  'podium.sidebarTab',
  'podium.selectedWorktree',
  'podium.selectedIssueId',
  'podium.sidebarLayout',
  'podium.dockTab',
  'podium.paneA',
  'podium.paneB',
  'podium.split',
  'podium.superOpen',
  'podium.panelMode',
  'podium.homeMode',
  'podium.issues.display',
  'podium.panelModeDefault',
] as const

/** Legacy key PREFIXES (dynamic suffixes: collapsed sections, sidebar width,
 *  dock-section open state). Each matched key migrates under its own name. */
export const LEGACY_UI_PREFIXES = ['podium:sidebar:', 'podium.dock.section.'] as const

/** Legacy PER-FILE key families (`podium.htmlmode:<tabId>` etc.) folded into ONE
 *  ui-state row per family: a JSON map { [tabId]: value }. Unbounded per-key
 *  families would otherwise litter the kv space; a map row reads/writes whole. */
export const LEGACY_UI_MAP_PREFIXES: Record<string, string> = {
  'podium.htmlmode:': 'podium.htmlmode',
  'podium.mdmode:': 'podium.mdmode',
}

/** Keys MIRRORED into ui-state but NOT removed from localStorage: the theme is
 *  read before React (index.html's anti-flash script) and before the store
 *  exists (ThemeProvider wraps StoreProvider), so the raw localStorage fast
 *  path must keep working. ThemeProvider write-through keeps both in sync. */
export const MIRRORED_UI_KEYS = ['podium.theme.preset', 'podium.theme.mode'] as const

/** Spec §2.3: "last ~200 items per conversation, LRU cap ~50 conversations". */
export const REPLICA_TRANSCRIPT_ITEM_CAP = 200
export const REPLICA_TRANSCRIPT_CONVERSATION_CAP = 50

export const REPLICA_KEY_PREFIX = 'podium.replica'

export interface ReplicaInit {
  /** Storage seam (mirrors outbox.ts): tests inject a fake; defaults to window.localStorage. */
  storage?: StorageApi
  /** Key enumerator for the one-time ui-state migration (prefix-matched legacy
   *  keys can't be probed individually). Defaults to Object.keys(localStorage)
   *  when running on the real window.localStorage; empty otherwise. */
  enumerateKeys?: () => string[]
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

/** One persisted UI preference. */
interface UiRow {
  key: string
  value: string
}

/** Persisted outbox entry (P6b): the OutboxEntry plus a stable FIFO ordinal. */
type OutboxRow = OutboxEntry & { seq: number }

/** Canonical value shape of an entry — the change detector for in-place
 *  transitions (#263 review finding 1: queued → awaiting-truth stamps
 *  state/resolvedAt on an EXISTING mutationId, which the old insert/delete
 *  diff would silently drop). */
function outboxEntryShape(e: OutboxEntry): string {
  return JSON.stringify([
    e.kind,
    e.input,
    e.queuedAt,
    e.state ?? null,
    e.resolvedAt ?? null,
    e.baseline ?? null,
    e.chained ?? null,
  ])
}

function maxSeq(rows: OutboxRow[]): number {
  let max = -1
  for (const r of rows) if (typeof r.seq === 'number' && r.seq > max) max = r.seq
  return max
}

/** In-place full replace of a draft's contents with `value`.
 *
 *  Update drafts are TanStack DB change-tracking proxies over the stored object.
 *  Crucially they record ASSIGNMENTS but ignore `delete draft[k]` — so a field
 *  that goes present→absent (an issue's `deferUntil` cleared on unsnooze, or any
 *  optional nulled) can't be removed by deletion; the stale value would survive
 *  and the row never reconciles (#170: a cleared snooze whose "Unsnoozed" tag
 *  never went away). Assigning `undefined` IS tracked and serializes away (JSON
 *  drops it, `x != null` reads it as cleared), so overwrite dropped keys with
 *  undefined instead of deleting them. */
function replaceContents(draft: Record<string, unknown>, value: Record<string, unknown>): void {
  for (const k of Object.keys(draft)) {
    if (!(k in value)) draft[k] = undefined
  }
  Object.assign(draft, value)
}

/** Collections are identified globally by id; give each adapter instance a
 *  unique id (same storageKey) so tests can build several without colliding. */
let instanceSeq = 0

/** Map-backed StorageApi for the private-mode fallback — same seam, no DOM.
 *  Also the explicit adapter for private/ephemeral mode on any platform. */
export function memoryStorage(): StorageApi {
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

/** Entity collection kinds + transcripts — everything the quota guard covers. */
const ENTITY_STORE_KINDS = ['sessions', 'issues', 'conversations', 'transcripts'] as const

/** Shared empty-rows identity for `rows()` (see the interface note). */
const EMPTY_ROWS: never[] = []

class TanstackReplica implements Replica {
  readonly persistent: boolean
  private readonly storage: StorageApi
  /** Issue #181 hotfix: true once an entity-blob write hit the storage quota.
   *  From then on entity persistence is in-memory only for this session and the
   *  persisted cursor is void (see degradeEntityWrites). */
  private entityWritesDegraded = false
  /** Post-degrade backing for entity blobs, so the collections' storage sync
   *  keeps working over the same seam (values just stop being durable). */
  private readonly entityOverlay = new Map<string, string>()
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
  private outboxAwaitingBacking: OutboxStorage | undefined
  /** Lazily-built ui-state backing — separate from `cols` for the same reason. */
  private uiBacking: UiState | undefined
  private readonly enumerateKeys: () => string[]
  /** Settles when every entity write issued so far has persisted — the fence
   *  `setCursor` waits behind (spec invariant 3). */
  private lastWrite: Promise<unknown> = Promise.resolve()
  // ---- coalesced row notifications (#262 review) ----
  /** subscribeRows listeners per kind; ONE underlying collection subscription
   *  per kind relays through the batch gate (notifyRows). Entries are wrapper
   *  objects so the same callback can be subscribed twice independently. */
  private readonly rowListeners = new Map<ReplicaKind, Set<{ cb: () => void }>>()
  private readonly rowRelaysArmed = new Set<ReplicaKind>()
  /** > 0 while inside batch()/an internal batch — notifications defer + dedupe. */
  private batchDepth = 0
  private readonly pendingRowNotify = new Set<ReplicaKind>()
  /** True while flushRowNotify delivers: a listener that writes back into the
   *  replica defers + coalesces into the SAME flush loop instead of recursing
   *  (recursion duplicated notifications and could grow the stack unboundedly). */
  private flushing = false
  /** Consecutive microtask continuations of one non-converging flush (#263
   *  review finding 5) — bounds the pathological forever-writer. */
  private flushDeferrals = 0

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
    this.enumerateKeys =
      init.enumerateKeys ??
      (this.persistent && init.storage === undefined && typeof window !== 'undefined'
        ? () => Object.keys(window.localStorage)
        : () => [])
    this.nonce = ++instanceSeq
    // Entity/transcript collections run over the quota-guarded storage (issue
    // #181): production-sized data can blow the ~5MB localStorage quota, and the
    // collection layer swallows the QuotaExceededError — the guard makes that
    // failure observable so the cursor can stay honest (see degradeEntityWrites).
    const guarded = this.entityStorage()
    const guardedEvents = this.wrapStorageEvents(guarded, { dropWhenDegraded: true })
    this.cols = {
      sessions: this.makeCollection<SessionMeta>(
        'sessions',
        (s) => s.sessionId,
        guarded,
        guardedEvents,
      ),
      issues: this.makeCollection<IssueWire>('issues', (i) => i.id, guarded, guardedEvents),
      conversations: this.makeCollection<ConversationSummaryWire>(
        'conversations',
        (c) => c.id,
        guarded,
        guardedEvents,
      ),
      transcripts: this.makeCollection<TranscriptRow>(
        'transcripts',
        (t) => t.key,
        guarded,
        guardedEvents,
      ),
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
    // Hold the notification batch across the preload (#262 review): a
    // collection load emits per-collection change events; coalescing them means
    // subscribers see hydrate as at most ONE notification per kind, against the
    // fully loaded state.
    this.batchDepth++
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
    } finally {
      this.batchDepth--
      if (this.batchDepth === 0) this.flushRowNotify()
    }
  }

  applySnapshot<K extends ReplicaKind>(kind: K, rows: ReplicaRows[K][]): void {
    try {
      // One notification for the whole snapshot (#262 review): the stale-delete
      // and the upsert are SEPARATE storage transactions, and a listener that
      // reacted between them would observe a transient empty/partial list (the
      // engine's worktree-fallback + URL mirror fired on exactly that).
      this.batch(() => {
        const col = this.cols[kind]
        const keyOf = this.keyFor(kind)
        const next = new Set(rows.map((r) => keyOf(r)))
        const stale = (col.toArray as ReplicaRows[K][])
          .map((r) => keyOf(r))
          .filter((k) => !next.has(k))
        if (stale.length > 0) this.track(col.delete(stale))
        this.upsertRows(kind, rows)
      })
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
      // Same coalescing as applySnapshot: remove + upsert notify once.
      this.batch(() => {
        const col = this.cols[kind]
        const present = removeIds.filter((id) => col.has(id))
        if (present.length > 0) this.track(col.delete(present))
        this.upsertRows(kind, upserts)
      })
    } catch (err) {
      console.warn(`[podium] replica applyChanges(${kind}) failed`, err)
    }
  }

  batch<T>(fn: () => T): T {
    this.batchDepth++
    try {
      return fn()
    } finally {
      this.batchDepth--
      if (this.batchDepth === 0) this.flushRowNotify()
    }
  }

  getCursor(): number | null {
    // A degraded session has no durable entity data — a persisted cursor would
    // lie about what's on disk, so read it as "never synced" (full resync).
    if (this.entityWritesDegraded) return null
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
      // Cursor honesty (issue #181): the cursor may only advance when the data
      // it covers actually persisted. TanStack's localStorage sync swallows a
      // QuotaExceededError (the entity write fails SILENTLY) while this tiny
      // write would still succeed — a reload would then hydrate STALE
      // collections yet resume from an ADVANCED cursor: a permanent gap, with
      // the missing entities never refetched. The guarded entity storage flips
      // entityWritesDegraded on the first failed blob write; checking it HERE
      // (after the fence, i.e. after those writes ran) refuses the advance.
      if (this.entityWritesDegraded) return
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

  rows<K extends ReplicaKind>(kind: K): ReplicaRows[K][] {
    try {
      const rows = this.cols[kind].toArray as ReplicaRows[K][]
      // Stable empty identity so downstream identity checks don't churn pre-hydrate
      // (mirrors useReplicaRows' EMPTY_ROWS).
      return rows.length === 0 ? (EMPTY_ROWS as ReplicaRows[K][]) : rows
    } catch {
      return EMPTY_ROWS as ReplicaRows[K][]
    }
  }

  subscribeRows(kind: ReplicaKind, cb: () => void): () => void {
    try {
      let set = this.rowListeners.get(kind)
      if (!set) {
        set = new Set()
        this.rowListeners.set(kind, set)
      }
      if (!this.rowRelaysArmed.has(kind)) {
        // ONE underlying subscription per kind, kept for the replica's lifetime
        // (the constructor already pins each collection's sync the same way);
        // every change funnels through the batch gate so notifications coalesce.
        this.cols[kind].subscribeChanges(() => this.notifyRows(kind))
        this.rowRelaysArmed.add(kind)
      }
      const entry = { cb }
      set.add(entry)
      return () => set.delete(entry)
    } catch {
      return () => {}
    }
  }

  /** Fire (or, inside a batch/flush, defer + dedupe) `kind`'s row listeners. */
  private notifyRows(kind: ReplicaKind): void {
    if (this.batchDepth > 0 || this.flushing) {
      this.pendingRowNotify.add(kind)
      return
    }
    this.deliverRows(kind)
  }

  private deliverRows(kind: ReplicaKind): void {
    const set = this.rowListeners.get(kind)
    if (!set || set.size === 0) return
    // Copy before iterating: a listener may unsubscribe (or subscribe) others.
    for (const entry of [...set]) {
      try {
        entry.cb()
      } catch {
        // a listener must never break the write path
      }
    }
  }

  /** Deliver the notifications deferred during a batch — once per kind, against
   *  the final state. A listener may write again; those writes defer into this
   *  SAME loop (iterative, guarded by `flushing` — never recursive) and get one
   *  follow-up delivery per settled state. The per-flush round cap bounds the
   *  SYNCHRONOUS stack only (#263 review finding 5): on hitting it the
   *  remainder continues in a microtask instead of being dropped — clearing
   *  would leave subscribers stuck behind replica truth until the NEXT write.
   *  A listener that writes on EVERY notification still cannot converge; after
   *  a bounded number of deferred continuations it is cut off loudly rather
   *  than spinning the microtask queue forever. */
  private flushRowNotify(): void {
    if (this.flushing || this.pendingRowNotify.size === 0) return
    this.flushing = true
    try {
      let rounds = 0
      while (this.pendingRowNotify.size > 0) {
        if (++rounds > 100) {
          if (++this.flushDeferrals > 10) {
            console.error(
              '[podium] replica row notifications did not converge (a listener writes on every ' +
                'notification?) — dropping the remainder',
            )
            this.pendingRowNotify.clear()
            this.flushDeferrals = 0
            return
          }
          console.error(
            '[podium] replica row notifications did not converge synchronously — deferring ' +
              'the remainder to a microtask',
          )
          queueMicrotask(() => this.flushRowNotify())
          return
        }
        const pending = [...this.pendingRowNotify]
        this.pendingRowNotify.clear()
        for (const kind of pending) this.deliverRows(kind)
      }
      this.flushDeferrals = 0
    } finally {
      this.flushing = false
    }
  }

  /** Loud (never-degrade) storage for the outbox-family collections: unlike
   *  the entity blobs, a lost outbox entry is a lost user write — a quota-dead
   *  write is a data-loss risk and is logged loudly instead of swallowed. */
  private outboxLoudStorage(): StorageApi {
    return {
      getItem: (k) => this.storage.getItem(k),
      setItem: (k, v) => {
        try {
          this.storage.setItem(k, v)
        } catch (err) {
          console.error(
            '[podium] OUTBOX persistence failed (storage quota?) — queued offline writes may ' +
              'be LOST on reload',
            err,
          )
          throw err
        }
      },
      removeItem: (k) => this.storage.removeItem(k),
    }
  }

  /** Build one outbox-family collection (queued or awaiting) and start its
   *  synchronous storage sync. */
  private makeOutboxCollection(name: 'outbox' | 'outbox-awaiting') {
    const loud = this.outboxLoudStorage()
    const col = this.makeCollection<OutboxRow>(
      name,
      (r) => r.mutationId,
      loud,
      this.wrapStorageEvents(loud, { dropWhenDegraded: false }),
    )
    // Permanent no-op subscriber: starts the collection's (synchronous)
    // localStorage sync and keeps it from being GC'd between accesses.
    try {
      col.subscribeChanges(() => {})
    } catch (err) {
      console.warn(`[podium] replica ${name} collection start failed`, err)
    }
    return col
  }

  /** `OutboxStorage` over one outbox-family collection. `seq` is assigned once
   *  at first sight and never rewritten, so ordering survives reloads and
   *  front-of-queue drops without churning rows. */
  private outboxCollectionBacking(
    c: ReturnType<TanstackReplica['makeOutboxCollection']>,
  ): OutboxStorage {
    return {
      load: () => {
        try {
          return (
            (c.toArray as OutboxRow[])
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
                ...(r.state !== undefined ? { state: r.state } : {}),
                ...(r.resolvedAt !== undefined ? { resolvedAt: r.resolvedAt } : {}),
                ...(r.baseline !== undefined ? { baseline: r.baseline } : {}),
                ...(r.chained !== undefined ? { chained: r.chained } : {}),
              }))
          )
        } catch {
          return []
        }
      },
      save: (entries) => {
        try {
          const existing = new Map((c.toArray as OutboxRow[]).map((r) => [r.mutationId, r]))
          const keep = new Set(entries.map((e) => e.mutationId))
          const stale = [...existing.keys()].filter((id) => !keep.has(id))
          if (stale.length > 0) this.track(c.delete(stale))
          let seq = maxSeq([...existing.values()])
          // The queue only pushes at the back and shifts from the front, so the
          // new (unseen) entries arrive in FIFO order — ascending seq matches it.
          const inserts = entries
            .filter((e) => !existing.has(e.mutationId))
            .map((e) => ({ ...e, seq: ++seq }))
          if (inserts.length > 0) this.track(c.insert(inserts))
          // In-place transitions (#263 review finding 1): a surviving entry can
          // change (queued → state:'awaiting-truth' + resolvedAt) — rewrite it
          // under its existing seq. replaceContents assigns dropped keys
          // undefined rather than deleting (#170).
          for (const e of entries) {
            const prev = existing.get(e.mutationId)
            if (prev === undefined || outboxEntryShape(prev) === outboxEntryShape(e)) continue
            this.track(
              c.update(e.mutationId, (draft: Record<string, unknown>) =>
                replaceContents(draft, { ...e, seq: prev.seq } as unknown as Record<
                  string,
                  unknown
                >),
              ),
            )
          }
        } catch (err) {
          console.warn('[podium] replica outbox save failed', err)
        }
      },
    }
  }

  outboxStorage(): OutboxStorage {
    if (this.outboxBacking) return this.outboxBacking
    const col = this.makeOutboxCollection('outbox')
    try {
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
    this.outboxBacking = this.outboxCollectionBacking(col)
    return this.outboxBacking
  }

  outboxAwaitingStorage(): OutboxStorage {
    if (this.outboxAwaitingBacking) return this.outboxAwaitingBacking
    // Separate home for resolved-but-uncovered entries (#263 review round 2):
    // `<prefix>.outbox-awaiting.v1` — a key OLD builds never read, so a PWA
    // rollback can't re-drain held entries as queued mutations. The Outbox
    // itself adopts any state-marked rows it finds in the legacy collection.
    this.outboxAwaitingBacking = this.outboxCollectionBacking(
      this.makeOutboxCollection('outbox-awaiting'),
    )
    return this.outboxAwaitingBacking
  }

  uiState(): UiState {
    if (this.uiBacking) return this.uiBacking
    const col = this.makeCollection<UiRow>('uistate', (r) => r.key)
    try {
      // Start (and pin) the collection's synchronous storage sync.
      col.subscribeChanges(() => {})
      // One-time migration: fold every known ad-hoc localStorage key into the
      // collection (existing rows win), then retire the old keys.
      const legacy = new Map<string, string>()
      const consider = (k: string): void => {
        try {
          const v = this.storage.getItem(k)
          if (v !== null) legacy.set(k, v)
        } catch {
          // unreadable key — skip
        }
      }
      for (const k of LEGACY_UI_KEYS) consider(k)
      const mapPrefixes = Object.keys(LEGACY_UI_MAP_PREFIXES)
      /** Per-family fold: target row key → { [suffix]: value }. */
      const mapFolds = new Map<string, Record<string, string>>()
      const foldedKeys: string[] = []
      for (const k of this.enumerateKeys()) {
        if (LEGACY_UI_PREFIXES.some((p) => k.startsWith(p))) consider(k)
        const mapPrefix = mapPrefixes.find((p) => k.startsWith(p))
        if (mapPrefix) {
          try {
            const v = this.storage.getItem(k)
            if (v !== null) {
              const target = LEGACY_UI_MAP_PREFIXES[mapPrefix] as string
              const fold = mapFolds.get(target) ?? {}
              fold[k.slice(mapPrefix.length)] = v
              mapFolds.set(target, fold)
              foldedKeys.push(k)
            }
          } catch {
            // unreadable key — skip
          }
        }
      }
      const inserts: UiRow[] = []
      for (const [key, value] of legacy) {
        if (!col.has(key)) inserts.push({ key, value })
      }
      // Per-file families become ONE JSON-map row each. Entries already in the
      // collection's map win (same never-clobber rule as plain keys).
      const mapUpdates: UiRow[] = []
      for (const [target, fold] of mapFolds) {
        const existingRow = col.get(target) as UiRow | undefined
        let existing: Record<string, string> = {}
        try {
          const parsed: unknown = existingRow ? JSON.parse(existingRow.value) : {}
          if (parsed && typeof parsed === 'object') existing = parsed as Record<string, string>
        } catch {
          // corrupt map row — rebuilt from the fold below
        }
        const merged = { ...fold, ...existing }
        const value = JSON.stringify(merged)
        if (!existingRow) inserts.push({ key: target, value })
        else if (existingRow.value !== value) mapUpdates.push({ key: target, value })
      }
      // Theme keys are mirrored, not moved: index.html's anti-flash script and
      // the pre-store ThemeProvider read them straight from localStorage.
      for (const k of MIRRORED_UI_KEYS) {
        try {
          const v = this.storage.getItem(k)
          if (v !== null && !col.has(k)) inserts.push({ key: k, value: v })
        } catch {
          // unreadable key — skip
        }
      }
      if (inserts.length > 0) this.track(col.insert(inserts))
      for (const u of mapUpdates) {
        this.track(
          col.update(u.key, (draft: UiRow) => {
            draft.value = u.value
          }),
        )
      }
      for (const key of [...legacy.keys(), ...foldedKeys]) {
        try {
          this.storage.removeItem(key)
        } catch {
          // removal is best-effort — the collection row is authoritative now
        }
      }
    } catch (err) {
      console.warn('[podium] ui-state migration failed', err)
    }
    this.uiBacking = {
      get: (key) => {
        try {
          return (col.get(key) as UiRow | undefined)?.value ?? null
        } catch {
          return null
        }
      },
      set: (key, value) => {
        try {
          if (value === null) {
            if (col.has(key)) this.track(col.delete(key))
          } else if (col.has(key)) {
            this.track(
              col.update(key, (draft: UiRow) => {
                draft.value = value
              }),
            )
          } else {
            this.track(col.insert({ key, value }))
          }
        } catch (err) {
          console.warn('[podium] ui-state set failed', err)
        }
      },
      subscribe: (cb) => {
        try {
          const sub = col.subscribeChanges(() => cb())
          return () => sub.unsubscribe()
        } catch {
          return () => {}
        }
      },
    }
    return this.uiBacking
  }

  // ---- internals ----

  /**
   * Quota guard for the entity/transcript blobs (issue #181 hotfix). Production
   * data can exceed the ~5MB localStorage quota; when a whole-collection JSON
   * write throws, this wrapper — the storage the collections actually see —
   * catches it and permanently degrades THIS session to in-memory persistence:
   * - live data keeps flowing (writes land in the overlay; the collections'
   *   in-memory state — the read path — never depended on the blob write);
   * - the persisted entity blobs AND cursor are cleared, so the next load
   *   cold-starts with a FULL resync instead of resuming over a silent gap;
   * - no further durable entity writes are attempted (no throw-per-batch churn).
   * ui-state and the outbox are NOT covered: they're small, and the outbox must
   * stay durable (its failures are logged loudly instead — see outboxStorage).
   * Follow-up (not this hotfix): bound what's persisted / move to IndexedDB so
   * typical production data fits in the first place.
   */
  private entityStorage(): StorageApi {
    return {
      getItem: (k) =>
        this.entityWritesDegraded && this.entityOverlay.has(k)
          ? (this.entityOverlay.get(k) ?? null)
          : this.storage.getItem(k),
      setItem: (k, v) => {
        if (this.entityWritesDegraded) {
          this.entityOverlay.set(k, v)
          return
        }
        try {
          this.storage.setItem(k, v)
        } catch (err) {
          this.degradeEntityWrites(err)
          this.entityOverlay.set(k, v)
        }
      },
      removeItem: (k) => {
        this.entityOverlay.delete(k)
        try {
          this.storage.removeItem(k)
        } catch {
          // removal is best-effort
        }
      },
    }
  }

  /**
   * Cross-tab events for a wrapped storage: the collection filters events on
   * `event.storageArea !== <configured storage>`, and a wrapper is a different
   * object than the real window.localStorage the browser stamps on the event —
   * so events must be re-stamped with the wrapper's identity or cross-tab sync
   * silently dies. Once degraded, entity events are dropped entirely: durable
   * storage no longer reflects this tab's truth, so a foreign tab's blob write
   * must not clobber the in-memory rows.
   */
  private wrapStorageEvents(
    wrapped: StorageApi,
    opts: { dropWhenDegraded: boolean },
  ): StorageEventApi {
    const real = this.storageEventApi
    const wrappedBy = new WeakMap<(e: StorageEvent) => void, (e: StorageEvent) => void>()
    return {
      addEventListener: (type, listener) => {
        const relay = (event: StorageEvent): void => {
          if (opts.dropWhenDegraded && this.entityWritesDegraded) return
          if (event.storageArea === (this.storage as unknown as Storage)) {
            // The handler only reads .key/.storageArea (then re-reads storage).
            listener({
              key: event.key,
              newValue: event.newValue,
              oldValue: event.oldValue,
              storageArea: wrapped,
            } as unknown as StorageEvent)
          } else {
            listener(event)
          }
        }
        wrappedBy.set(listener, relay)
        real.addEventListener(type, relay)
      },
      removeEventListener: (type, listener) => {
        const relay = wrappedBy.get(listener)
        if (relay) real.removeEventListener(type, relay)
      },
    }
  }

  /** First quota failure → permanent in-memory degrade + clear persisted entity
   *  state and cursor (they may be mutually inconsistent from this instant on). */
  private degradeEntityWrites(err: unknown): void {
    if (this.entityWritesDegraded) return
    this.entityWritesDegraded = true
    console.warn(
      '[podium] replica entity write failed (storage quota?) — persisting in memory only for ' +
        'this session and clearing the stored entity data + cursor so the next load does a ' +
        'full resync',
      err,
    )
    for (const kind of ENTITY_STORE_KINDS) {
      try {
        this.storage.removeItem(`${this.prefix}.${kind}.v1`)
      } catch {
        // freeing quota is best-effort
      }
    }
    try {
      this.storage.removeItem(this.cursorKey)
    } catch {
      // best-effort — getCursor also reads null while degraded
    }
  }

  private makeCollection<T extends object>(
    kind: string,
    getKey: (row: T) => string,
    storage: StorageApi = this.storage,
    storageEventApi: StorageEventApi = this.storageEventApi,
  ) {
    return createCollection(
      localStorageCollectionOptions<T, string>({
        // Collections are identified globally by id; the per-instance nonce lets
        // tests build several adapters over the same storageKey without colliding.
        id: `${this.prefix}.${kind}#${this.nonce}`,
        storageKey: `${this.prefix}.${kind}.v1`,
        storage,
        storageEventApi,
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
