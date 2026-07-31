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
  IssueDepProjection,
  IssueProjection,
  IssueWire,
  RepoProjection,
  SessionMeta,
  TranscriptItem,
} from '@podium/model'
import type { OutboxStorage } from '../outbox'
import type { FeedCursor } from './feed'

/** Synchronous key-value storage seam. Tests inject a fake; the browser passes
 *  `window.localStorage`. Shape-identical to what the outgoing adapter's library
 *  declared, so values flow to it unchanged while it still exists. */
export type StorageApi = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Cross-tab `storage` events — a subset of `Window`. */
export type StorageEventApi = {
  addEventListener: (type: 'storage', listener: (event: StorageEvent) => void) => void
  removeEventListener: (type: 'storage', listener: (event: StorageEvent) => void) => void
}

/**
 * The issue projection AS A REPLICA ROW — the projection plus the per-user read
 * state, which is NOT part of the projection on this branch.
 *
 * `IssueProjection` here is a pure function of the issue's own durable row
 * (model's `aggregates/issue.ts`: "per-user state is absent by construction"), so
 * unlike main's it carries no `readAt`. The client-side machinery main added
 * still needs to name that field: `issueMarkRead`/`issueMarkUnread` write an
 * optimistic overlay onto an `issueProjections` row and judge covering truth by
 * reading it back, and the replica-side views take it as an input.
 *
 * Naming it HERE rather than putting it back on the model keeps the divergence
 * in one place and states the truth about the wire: the row MAY carry per-user
 * read state, and today this branch's authority does not emit it — the normalized
 * feed's per-user slice is its own entity and its own piece of work. Optional,
 * therefore, rather than `| null`: absent means "this feed does not carry it",
 * which is a different fact from "read never happened".
 */
export type IssueProjectionRow = IssueProjection & { readAt?: string | null }

/** Wire row type per replica collection kind. */
export interface ReplicaRows {
  sessions: SessionMeta
  /** The LEGACY embedded issue wire. Still held through the transition [POD-796]:
   *  the rich issue UI reads it directly, and it carries `deps`/`prefix`/derived
   *  fields as columns. POD-797 deletes it once every surface reads the views. */
  issues: IssueWire
  /** The NORMALIZED issue projection [POD-796] — the issue's own durable row,
   *  nothing derived. The replica-side issue VIEWS read this, joined against the
   *  two kinds below (see `readViewInputs`). Empty unless the authority's flag is
   *  on and this client offered the cap. */
  issueProjections: IssueProjectionRow
  /** Issue dependency EDGES [POD-822] — `issue_deps` as first-class rows. The
   *  views join these by `fromId` to derive `blocked`/`ready`/`dependents`; the
   *  projection cannot carry them (an edge belongs to two issues). */
  issueDeps: IssueDepProjection
  /** Logical repos [POD-822] — `(id, prefix)`. The views join `issue.repoId →
   *  repo.prefix` for `displayRef`; a prefix change moves every `POD-13` in the
   *  repo without rewriting an issue (D7.2). */
  repos: RepoProjection
  conversations: ConversationSummaryWire
  automations: AutomationWire
  automationRuns: AutomationRunWire
}
export type ReplicaKind = keyof ReplicaRows

export interface ReplicaHydrateResult {
  sessions: SessionMeta[]
  issues: IssueWire[]
  /** The three POD-796/POD-822 kinds, persisted like every other collection so a
   *  warm reload paints the views from local data and re-seeds the hub's
   *  in-memory lists (see `seedMetadata`). Empty until the cap flips. */
  issueProjections: IssueProjectionRow[]
  issueDeps: IssueDepProjection[]
  repos: RepoProjection[]
  conversations: ConversationSummaryWire[]
  automations: AutomationWire[]
  automationRuns: AutomationRunWire[]
  /** Last persisted oplog cursor, or null when never synced (cold client). */
  cursor: number | null
  /** The same cursor as the ADR 2 D1 TRIPLE — `COLD_CURSOR` when never synced.
   *  `cursor` above is this one's `seq` and nothing more; it stays only for the
   *  shipped seq-only SocketHub path (POD-796 deletes it with that path). */
  feedCursor: FeedCursor
  /** True when hydrate found a cache written by a DIFFERENT replica schema
   *  version and discarded it (ADR 2 D7 rung 6). The lists are empty and the
   *  cursor is cold; the outbox survived. Surfaced rather than logged because a
   *  silent version reset is indistinguishable from a cold start. */
  schemaReset: boolean
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
  /** The cursor as ADR 2 D1's triple. `COLD_CURSOR` when never synced. */
  getFeedCursor(): FeedCursor
  /** Persist the whole triple, behind the same persist-after-data fence as
   *  {@link setCursor} (ADR 2 D10 / ADR 6 D4.2). */
  setFeedCursor(cursor: FeedCursor): void
  /**
   * ADR 2 D7 rungs 4–6: discard the CACHE, keep the OUTBOX. One operation,
   * because the two halves must never be separable at a call site.
   *
   * WE own this rather than delegating to the store's own reset, and the reason
   * is specific (POD-794 addendum 2, reproduced): TanStack's reset is
   * COLLECTION-SCOPED — it clears the tables it knows about and nothing else.
   * That property cuts both ways. It cannot eat our outbox, which is why D7's
   * most dangerous sentence is safe by construction. But it cannot clear our
   * CURSOR either, and a reset that leaves entities=0 with cursor=77 is a
   * PERMANENT SILENT HOLE: `changesSince(77)` answers "caught up" over an empty
   * replica forever, and no rung of the ladder detects it because every rung's
   * exit condition looks satisfied.
   *
   * Order is not arbitrary — the cursor goes FIRST. ADR 6 D4.2 forbids a cursor
   * ahead of its data and makes data ahead of a lost cursor advance recoverable
   * by re-pull; a crash mid-reset must therefore land on the recoverable side.
   */
  resetCache(): void
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

/**
 * A Map-backed store that ALSO reports what it holds.
 *
 * The readout is not a debugging convenience — it is what makes "this replica
 * persists nothing" a checkable claim rather than a comment. Two callers already
 * needed it and each hand-rolled its own Map because `memoryStorage()` hid its
 * own: `legacy-keys.test.ts` ("`memoryStorage()` hides its map; this one is the
 * same seam with the key set observable, which is the whole measurement") and
 * `legacy-snapshot.ts`, whose entire job is to hand back every key the writer
 * wrote. A seam that has to be re-implemented to be observed is a seam that gets
 * re-implemented slightly differently each time.
 */
export interface MemoryStorage extends StorageApi {
  /** Every key currently held, in insertion order. */
  keys(): string[]
  /** The whole store as a plain object — a copy, so a later write cannot
   *  retroactively change a snapshot someone already took. */
  snapshot(): Record<string, string>
}

/** Map-backed StorageApi for the private-mode fallback — same seam, no DOM.
 *  Also the explicit adapter for private/ephemeral mode on any platform, and the
 *  one construction the client audit's unattributed-store item accepts as proof
 *  that a composition root persists nothing (`scripts/audit-phase2-client.ts`). */
export function memoryStorage(): MemoryStorage {
  const data = new Map<string, string>()
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    keys: () => [...data.keys()],
    snapshot: () => Object.fromEntries(data),
  }
}
