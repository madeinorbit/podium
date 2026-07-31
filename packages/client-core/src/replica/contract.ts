/**
 * THE CLIENT REPLICA CONTRACT, owned by client-core (POD-378).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY IT HAD TO EXIST BEFORE THE DELETION
 * ---------------------------------------------------------------------------
 *
 * POD-378 deletes the TanStack DB adapter and the dependency. The dependency is
 * the harder half, and the reason is not obvious from the import graph: until
 * this file, `replica.ts` both IMPLEMENTED the legacy replica and OWNED the
 * contract, and the KERNEL path read its contract out of it —
 * `kernel/facade.ts`, `kernel/side-cache.ts` and `kernel/kinds.ts` all imported
 * from `../replica`.
 *
 * Two of those imported names were never ours:
 *
 *     replica.ts   import type { StorageApi, StorageEventApi } from '@tanstack/db'
 *     replica.ts   export type { …, StorageApi, StorageEventApi }
 *
 * `grep -rn "interface StorageApi" packages apps` returned NOTHING — the only
 * declaration in the repo was inside `@tanstack/db`, re-exported through
 * `replica.ts`, and consumed by the kernel side cache. So the replacement's own
 * type surface routed through the package being removed, and deleting the
 * adapter would not have taken the dependency out of the lockfile. It would have
 * produced a build that still type-checks and a `bun.lock` that still carries
 * `@tanstack/db` — which is exactly why the acceptance evidence for that clause
 * is the LOCKFILE and not a green typecheck.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STORAGE TYPES ARE RE-DECLARED RATHER THAN RE-EXPORTED
 * ---------------------------------------------------------------------------
 *
 * They are structural aliases over DOM types, so re-declaring them costs
 * nothing and keeps assignability exact: `replica.ts` still hands these values
 * to TanStack's own APIs while it lives, and a shape that drifted would fail
 * there rather than here. They are reproduced verbatim in shape:
 *
 *     StorageApi      = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
 *     StorageEventApi = add/removeEventListener('storage', …)
 *
 * The alternative — leaving them imported and deleting the adapter anyway — is
 * the version of this that looks finished and is not.
 *
 * ---------------------------------------------------------------------------
 * WHAT BELONGS HERE, AND WHAT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 *
 * HERE: the contract every client replica implementation must satisfy, and the
 * constants that describe the client's persisted key space. Both outlive the
 * TanStack adapter — the kernel facade already implements the one and reuses
 * the other.
 *
 * NOT HERE: anything TanStack-shaped. `PersistedCollectionPersistence`,
 * `PersistedReplicaInit` and `ReplicaInit` stay in `replica.ts` and die with it.
 * A contract module that carried the outgoing implementation's initialisation
 * shape would just move the problem one file across.
 */

import type {
  AutomationRunWire,
  AutomationWire,
  ConversationSummaryWire,
  IssueWire,
  SessionMeta,
  TranscriptItem,
} from '@podium/model'
import type { OutboxStorage } from '../outbox'

/** Synchronous key-value storage seam. Tests inject a fake; the browser passes
 *  `window.localStorage`. Shape-identical to what the outgoing adapter's library
 *  declared, so values flow to it unchanged while it still exists. */
export type StorageApi = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Cross-tab `storage` events — a subset of `Window`. */
export type StorageEventApi = {
  addEventListener: (type: 'storage', listener: (event: StorageEvent) => void) => void
  removeEventListener: (type: 'storage', listener: (event: StorageEvent) => void) => void
}

/** Wire row type per replica collection kind. */
export interface ReplicaRows {
  sessions: SessionMeta
  issues: IssueWire
  conversations: ConversationSummaryWire
  automations: AutomationWire
  automationRuns: AutomationRunWire
}
export type ReplicaKind = keyof ReplicaRows

export interface ReplicaHydrateResult {
  sessions: SessionMeta[]
  issues: IssueWire[]
  conversations: ConversationSummaryWire[]
  automations: AutomationWire[]
  automationRuns: AutomationRunWire[]
  /** Last persisted oplog cursor, or null when never synced (cold client). */
  cursor: number | null
}

/** A cached transcript window: the newest items read for one conversation. */
export interface TranscriptWindow {
  items: TranscriptItem[]
  /** Epoch ms when the window was written — drives the "as of <time>" notice. */
  savedAt: number
}

/** Synchronous UI-state kv over the ui-state collection. Never throws. */
export interface UiState {
  get(key: string): string | null
  /** `null` deletes the key. */
  set(key: string, value: string | null): void
  /** Fires on any ui-state change (including cross-tab storage events). */
  subscribe(cb: () => void): () => void
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
  /** Write-through cache of a fresh read. Bounded per spec §2.3. */
  putTranscriptWindow(conversationKey: string, items: TranscriptItem[]): void
  /** The underlying entity collection for `kind` — the live-query seam (typed
   *  `unknown` so no implementation type leaks through the interface). */
  collection(kind: ReplicaKind): unknown
  /** Non-React read seam (#262 [spec:SP-3fe2]): the current rows for `kind`.
   *  Returns a stable shared empty array while the collection is empty. Never throws. */
  rows<K extends ReplicaKind>(kind: K): ReplicaRows[K][]
  /** Non-React change seam (#262). Notifications are COALESCED per application:
   *  a listener never observes the transient half-applied list. Never throws. */
  subscribeRows(kind: ReplicaKind, cb: () => void): () => void
  /** Coalesce `subscribeRows` notifications across every write issued inside
   *  `fn` (#262 review, nestable): listeners fire at most once per touched kind,
   *  AFTER the outermost batch completed — i.e. against the FINAL state. */
  batch<T>(fn: () => T): T
  /** P6b outbox consolidation: the offline queue's durable home. */
  outboxStorage(): OutboxStorage
  /** Separate durable home for the outbox's awaiting-truth stage (#263 review
   *  round 2), which OLD builds never read — a downgraded client cannot re-drain
   *  held entries as queued mutations. */
  outboxAwaitingStorage(): OutboxStorage
  /** Durable home for entries parked for user recovery (POD-316, ADR 3 D9
   *  `dead-letter`). Separate from both homes above and never drained: D9
   *  invariant 1 forbids making user-authored work gone without the user's own
   *  discard or a successful apply, so this is where a definitively-refused
   *  write waits for them. */
  outboxDeadLetterStorage(): OutboxStorage
  /** ONE UI persistence mechanism (issue #15 Phase 4): a versioned key→value
   *  store replacing the ad-hoc localStorage keys. */
  uiState(): UiState
  /** Resolves when every write issued so far has persisted (including a
   *  fenced cursor write). */
  flush(): Promise<void>
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
 *  ui-state row per family: a JSON map { [tabId]: value }. */
export const LEGACY_UI_MAP_PREFIXES: Record<string, string> = {
  'podium.htmlmode:': 'podium.htmlmode',
  'podium.mdmode:': 'podium.mdmode',
}

/** Keys MIRRORED into ui-state but NOT removed from localStorage: the theme is
 *  read before React (index.html's anti-flash script) and before the store
 *  exists, so the raw localStorage fast path must keep working. */
export const MIRRORED_UI_KEYS = ['podium.theme.preset', 'podium.theme.mode'] as const

/** Spec §2.3: "last ~200 items per conversation, LRU cap ~50 conversations". */
export const REPLICA_TRANSCRIPT_ITEM_CAP = 200
export const REPLICA_TRANSCRIPT_CONVERSATION_CAP = 50

export const REPLICA_KEY_PREFIX = 'podium.replica'

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
