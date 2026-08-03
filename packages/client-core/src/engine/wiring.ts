/**
 * Engine transport + write-path wiring (#262 [spec:SP-3fe2]): constructs the
 * SocketHub (metadata delta mode, persist-after-apply into the replica) and the
 * Outbox (durable offline write queue over the replica's storage). Extracted
 * verbatim from react/provider.tsx so the engine — and any non-React client —
 * shares ONE construction path with zero React involvement.
 */

import type { ConfirmationRule } from '@podium/commands'
import type { SessionId, WorkState } from '@podium/model'
import {
  ENQUEUEABLE_DELIVERY,
  type OutboxCommand,
  type RetrySatisfaction,
} from '@podium/sync/outbox'
import type { PodiumClientApi } from '../api'
import {
  Outbox,
  type OutboxDeadLetterEntry,
  type OutboxEntry,
  platformIsOnline,
  platformOnlineEvents,
} from '../outbox'
import { reasonSummary } from '../outbox-recovery-copy'
import { applyLegacyMetadataState } from '../replica/legacy-wire-v1-binding'
import { LegacyWireV1Feed } from '../replica/legacy-wire-v1-feed'
import type { Replica } from '../replica/replica'
import { type FeedSinkPort, SocketHub } from '../socket-transport'
import type { StoreNotices } from './types'

/** Outboxed mutation kinds → their tRPC inputs (docs/spec/outbox-write-path.md
 *  §2.3). Each executor replays with the entry's stable mutationId, so the
 *  server dedupes across reload/reconnect. Replicated per-user rows (pins,
 *  tab order, and personal settings) use the same path. Live chat stays direct —
 *  it must fail fast rather than silently queue. */
export type OutboxKinds = {
  pinSet: Omit<Parameters<PodiumClientApi['pins']['set']['mutate']>[0], 'mutationId'>
  tabSetOrder: Omit<Parameters<PodiumClientApi['tabs']['setOrder']['mutate']>[0], 'mutationId'>
  layoutSet: Omit<Parameters<PodiumClientApi['layout']['set']['mutate']>[0], 'mutationId'>
  layoutClear: Omit<Parameters<PodiumClientApi['layout']['clear']['mutate']>[0], 'mutationId'>
  settingsUpdatePersonal: Omit<
    Parameters<PodiumClientApi['settings']['updatePersonal']['mutate']>[0],
    'mutationId'
  >
  resumeAndSend: { sessionId: SessionId; text: string }
  rename: { sessionId: SessionId; name: string }
  setArchived: { sessionId: SessionId; archived: boolean }
  setWorkState: { sessionId: SessionId; workState: WorkState | null }
  snoozeSet: { sessionId: SessionId; until: string | null }
  snoozeClear: { sessionId: SessionId }
  sessionMarkRead: { sessionId: SessionId }
  sessionMarkUnread: { sessionId: SessionId }
  issueMarkRead: { id: string }
  issueMarkUnread: { id: string }
  issueSetTucked: { id: string; tucked: boolean }
}

/** The engine-facing queue contract. Kernel-backed web clients inject this
 * implementation; legacy and mobile clients keep the compatibility queue. */
export interface EngineOutbox {
  attach(): void
  dispose(): void
  subscribe(listener: (size: number) => void): () => void
  size(): number
  pending(): OutboxEntry[]
  awaiting(): OutboxEntry[]
  deadLetters(): OutboxDeadLetterEntry[]
  enqueue<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
    opts?: { baseline?: string; chained?: boolean },
  ): OutboxEntry | Promise<OutboxEntry>
  retireAwaiting(mutationId: string): void
  retry(mutationId: string, satisfaction: RetrySatisfaction): unknown
  edit(mutationId: string, input: unknown): unknown
  discard(mutationId: string): unknown
  notifyConnected(): void
  drain(): Promise<void>
}

export interface EngineOutboxCallbacks {
  readonly api: PodiumClientApi
  readonly replica: Replica
  readonly notices: StoreNotices
  readonly onApplied?: (entry: OutboxEntry) => unknown
  readonly onDropped?: (entry: OutboxEntry) => void
  readonly onDeadLetter?: (parked: OutboxDeadLetterEntry) => void
}

export type CreateEngineOutbox = (callbacks: EngineOutboxCallbacks) => EngineOutbox

/** `ENQUEUEABLE_DELIVERY` narrowed and nothing else — the same value, reused
 *  rather than re-spelled, so a rename of the class reaches this table. */
const delivery = ENQUEUEABLE_DELIVERY as OutboxCommand['delivery']

/**
 * The CONTRACT TABLE, which `readLegacyReplica`, the outbox binding and the
 * dead-letter recovery surface all refuse to invent (ADR 3 D9): a client entry
 * carries a bare `kind` and an `OutboxCommand` needs `{name, version, delivery}`,
 * so guessing a version would re-author a queued write under a contract its
 * input may not satisfy.
 *
 * It is typed `Record<keyof OutboxKinds, …>` deliberately. That is the only
 * thing standing between this table and silent drift: adding a drainable kind
 * to the engine's queue without a contract here is a TYPE ERROR, rather than an
 * `unknown-command` rejection a user discovers when their offline work fails to
 * migrate.
 *
 * IT LIVES HERE, beside `OutboxKinds`, rather than in one app (POD-316). It used
 * to live in the mobile provider, and the web recovery surface needs the same
 * mapping — two copies would drift, and the thing that drifts is which contract
 * a queued write is replayed under.
 *
 * `confirmation` is the contract's own `policy.confirmation` (ADR 3 D2), carried
 * here so the recovery surface can tell whether an inline confirmation could
 * possibly satisfy a `confirmation-required` refusal WITHOUT importing the whole
 * command registry into the browser bundle (`audit:browser-reach`). It is a copy,
 * and `outbox-contract-table.test.ts` pins it EQUAL to the contract's value.
 *
 * Every version is 1 because every one of these contracts has only ever had one.
 * That is a statement about today, and the day one of them changes, the entry
 * here changes with it.
 */
export const OUTBOX_COMMANDS: Record<
  keyof OutboxKinds,
  OutboxCommand & { confirmation: ConfirmationRule }
> = {
  pinSet: { name: 'pins.set', version: 1, delivery, confirmation: 'none' },
  tabSetOrder: { name: 'tabs.setOrder', version: 1, delivery, confirmation: 'none' },
  layoutSet: { name: 'layout.set', version: 1, delivery, confirmation: 'none' },
  layoutClear: { name: 'layout.clear', version: 1, delivery, confirmation: 'none' },
  settingsUpdatePersonal: {
    name: 'settings.updatePersonal',
    version: 1,
    delivery,
    confirmation: 'none',
  },
  resumeAndSend: { name: 'sessions.resumeAndSend', version: 1, delivery, confirmation: 'none' },
  rename: { name: 'sessions.rename', version: 1, delivery, confirmation: 'none' },
  setArchived: { name: 'sessions.setArchived', version: 1, delivery, confirmation: 'none' },
  setWorkState: { name: 'sessions.setWorkState', version: 1, delivery, confirmation: 'none' },
  snoozeSet: { name: 'snoozes.set', version: 1, delivery, confirmation: 'none' },
  snoozeClear: { name: 'snoozes.clear', version: 1, delivery, confirmation: 'none' },
  sessionMarkRead: { name: 'sessions.markRead', version: 1, delivery, confirmation: 'none' },
  sessionMarkUnread: { name: 'sessions.markUnread', version: 1, delivery, confirmation: 'none' },
  issueMarkRead: { name: 'issues.markRead', version: 1, delivery, confirmation: 'none' },
  issueMarkUnread: { name: 'issues.markUnread', version: 1, delivery, confirmation: 'none' },
  issueSetTucked: { name: 'issues.setTucked', version: 1, delivery, confirmation: 'none' },
}

/**
 * POD-785 — WHERE each queued write sits in the queue, and WHETHER a later write
 * of the same kind makes it redundant.
 *
 * Both halves used to be one constant. Every client write went into a single
 * `client-outbox` partition, and ADR 3 D12 stops a partition at its first
 * unresolved entry — so ONE dead-lettered write (a rename refused after a share
 * was revoked, say) wedged the whole queue for ever, while the app kept queueing
 * read receipts behind it at ~361 B each. Measured: 500 receipts behind one
 * parked entry, 0 delivered after three drains. Per-target keys, same workload:
 * everything lands and only the revoked session stays stuck.
 * (docs/internal/pod-785-evidence/)
 *
 * The single-partition choice was inherited from the legacy IMPORT path, where it
 * is argued as "over-serialised and correct" — true for a one-shot drain of a
 * handful of entries, and false for the app's steady-state queue.
 *
 * ## partition — the ORDERING domain
 *
 * The target the write lands on. Two writes to the SAME row must share a key, or
 * they can reorder and a rename lands before the edit it was meant to follow
 * (this is what the legacy `chained` flag tracked). Two writes to DIFFERENT rows
 * must not, or one refusal blocks the other.
 *
 * ## collapse — the REDUNDANCY domain
 *
 * The STATE CELL the write sets, present only when a later write to that cell
 * fully subsumes an earlier one. `undefined` means never collapse, and it is the
 * answer for two whole classes:
 *
 *   - CONTENT-BEARING writes. `resumeAndSend` puts text into a live PTY; two
 *     sends are two sends. ADR 3 D11 names exactly this as the reason
 *     "idempotent-ish" is not a property we may lean on.
 *   - PARTIAL patches. `layout.set`, `layout.clear` and `settings.updatePersonal`
 *     carry only the keys they touch, so a later patch does NOT subsume an
 *     earlier one — collapsing them would silently drop the fields only the first
 *     one set.
 *
 * Where two different commands write the same cell they SHARE a collapse key:
 * `markRead`/`markUnread` on one issue, `snoozeSet`/`snoozeClear` on one session.
 * The newest wins, which is precisely what the user's last click meant.
 *
 * Typed `Record<keyof OutboxKinds, …>` for the same reason as `OUTBOX_COMMANDS`
 * above: adding a queued kind without deciding its ordering and its redundancy is
 * a TYPE ERROR, not a default that silently reinstates the wedge.
 */
export type OutboxRouting = {
  readonly partitionKey: string
  readonly collapseKey?: string
}

export const OUTBOX_ROUTING: {
  [K in keyof OutboxKinds]: (input: OutboxKinds[K]) => OutboxRouting
} = {
  // Per-user singletons: one partition each, so they no longer serialise behind
  // one another or behind any session's writes.
  pinSet: (i) => ({
    partitionKey: `pin:${i.kind}:${i.id}`,
    collapseKey: `pin:${i.kind}:${i.id}`,
  }),
  // Per WORKTREE, not global: the input names one worktree's tab order, so two
  // worktrees have no reason to serialise against each other. It sets the WHOLE
  // order for that worktree, which is what makes it collapsible.
  tabSetOrder: (i) => ({
    partitionKey: `tabs:${i.worktree}`,
    collapseKey: `tabs-order:${i.worktree}`,
  }),
  // `values`/`keys` are PARTIAL — no collapse.
  layoutSet: () => ({ partitionKey: 'layout' }),
  layoutClear: () => ({ partitionKey: 'layout' }),
  // A partial patch of personal settings — no collapse.
  settingsUpdatePersonal: () => ({ partitionKey: 'settings' }),

  // Session-targeted writes. All share the session's partition, so their order
  // relative to one another is preserved.
  resumeAndSend: (i) => ({ partitionKey: `session:${i.sessionId}` }),
  rename: (i) => ({
    partitionKey: `session:${i.sessionId}`,
    collapseKey: `session-name:${i.sessionId}`,
  }),
  setArchived: (i) => ({
    partitionKey: `session:${i.sessionId}`,
    collapseKey: `session-archived:${i.sessionId}`,
  }),
  setWorkState: (i) => ({
    partitionKey: `session:${i.sessionId}`,
    collapseKey: `session-work-state:${i.sessionId}`,
  }),
  snoozeSet: (i) => ({
    partitionKey: `session:${i.sessionId}`,
    collapseKey: `session-snooze:${i.sessionId}`,
  }),
  snoozeClear: (i) => ({
    partitionKey: `session:${i.sessionId}`,
    collapseKey: `session-snooze:${i.sessionId}`,
  }),
  sessionMarkRead: (i) => ({
    partitionKey: `session:${i.sessionId}`,
    collapseKey: `session-read:${i.sessionId}`,
  }),
  sessionMarkUnread: (i) => ({
    partitionKey: `session:${i.sessionId}`,
    collapseKey: `session-read:${i.sessionId}`,
  }),

  // Issue-targeted writes. `issues.markRead` is the command named in the
  // 2026-07-17 report as the trigger.
  issueMarkRead: (i) => ({
    partitionKey: `issue:${i.id}`,
    collapseKey: `issue-read:${i.id}`,
  }),
  issueMarkUnread: (i) => ({
    partitionKey: `issue:${i.id}`,
    collapseKey: `issue-read:${i.id}`,
  }),
  issueSetTucked: (i) => ({
    partitionKey: `issue:${i.id}`,
    collapseKey: `issue-tucked:${i.id}`,
  }),
}

/** Route one queued write. Falls back to the entry's own private partition — D12's
 *  rule for a command with no resolvable target — rather than to a shared one, so
 *  an unknown kind can never reinstate the global wedge. */
export const outboxRoutingFor = <K extends keyof OutboxKinds & string>(
  kind: K,
  input: OutboxKinds[K],
  mutationId: string,
): OutboxRouting => {
  const route = OUTBOX_ROUTING[kind] as ((i: OutboxKinds[K]) => OutboxRouting) | undefined
  return route ? route(input) : { partitionKey: `create:${mutationId}` }
}

/** The contract behind one queued kind, or `undefined` for a kind with no
 *  executor. */
export const outboxCommandFor = (
  kind: string,
): (OutboxCommand & { confirmation: ConfirmationRule }) | undefined =>
  OUTBOX_COMMANDS[kind as keyof OutboxKinds]

/** SocketHub construction seam — injectable so engine unit tests run a fake hub. */
export type CreateHub = (opts: ConstructorParameters<typeof SocketHub>[0]) => SocketHub

/** Expected cold-offline failures leave the persisted kernel slice mounted. */
export function isInitialConnectivityError(message: string): boolean {
  return (
    message === 'WebSocket connection failed' ||
    message === 'WebSocket connection closed before connecting'
  )
}

export function createEngineHub(args: {
  wsClientUrl: string
  api: PodiumClientApi
  replica: Replica
  onFatalError: (message: string) => void
  createHub?: CreateHub
  /**
   * WIRE v2 (POD-1223): when supplied, this hub advertises wire 2 and hands
   * every frame to the kernel Replica's consumer.
   *
   * The two feed ports are mutually exclusive. Canonical v2 envelopes go to
   * the supplied Replica sink; wire-v1 gets a Replica-owned compatibility sink.
   */
  feed?: FeedSinkPort
}): SocketHub {
  const { api, replica } = args
  const make: CreateHub = args.createHub ?? ((opts) => new SocketHub(opts))
  if (args.feed !== undefined) {
    return make({
      url: args.wsClientUrl,
      viewport: { cols: 80, rows: 24, dpr: globalThis.devicePixelRatio ?? 1 },
      onError: (message) => {
        if (!isInitialConnectivityError(message)) args.onFatalError(message)
      },
      feed: args.feed,
    })
  }
  return make({
    url: args.wsClientUrl,
    viewport: { cols: 80, rows: 24, dpr: globalThis.devicePixelRatio ?? 1 },
    onError: (message) => args.onFatalError(message),
    issuesNormalized: true,
    legacyFeed: new LegacyWireV1Feed({
      fetchChangesSince: (cursor) => api.sync.changesSince.query({ cursor }),
      initialCursor: replica.getCursor(),
      applied: (state) => applyLegacyMetadataState(replica, state),
    }),
  })
}

/** Durable write path for the covered mutations. The queue doubles as the
 *  optimistic overlay (#263: the outbox IS the overlay — see overlay.ts): a
 *  pending entry paints its patch over the replica's server truth, so an
 *  offline write both survives a reload AND keeps painting after it, then
 *  replays (deduped by mutationId) on reconnect. */
export function createEngineOutbox(args: EngineOutboxCallbacks): Outbox<OutboxKinds> {
  const { api } = args
  return new Outbox<OutboxKinds>({
    isOnline: platformIsOnline,
    onlineEvents: platformOnlineEvents(),
    // One persistence layer: the queue persists into a replica collection
    // (cross-tab consistent via storage events; in-memory in private mode);
    // the drain/retry/poison logic is unchanged. The awaiting-truth stage
    // lives in its OWN collection (#263 review round 2) so a downgraded build
    // reading the queued collection never re-drains held entries.
    storage: args.replica.outboxStorage(),
    awaitingStorage: args.replica.outboxAwaitingStorage(),
    deadLetterStorage: args.replica.outboxDeadLetterStorage(),
    executors: {
      pinSet: (i) => api.pins.set.mutate(i),
      tabSetOrder: (i) => api.tabs.setOrder.mutate(i),
      layoutSet: (i) => api.layout.set.mutate(i),
      layoutClear: (i) => api.layout.clear.mutate(i),
      settingsUpdatePersonal: (i) => api.settings.updatePersonal.mutate(i),
      resumeAndSend: (i) => api.sessions.resumeAndSend.mutate(i),
      rename: (i) => api.sessions.rename.mutate(i),
      setArchived: (i) => api.sessions.setArchived.mutate(i),
      setWorkState: (i) => api.sessions.setWorkState.mutate(i),
      snoozeSet: (i) => api.snoozes.set.mutate(i),
      snoozeClear: (i) => api.snoozes.clear.mutate(i),
      sessionMarkRead: (i) => api.sessions.markRead.mutate(i),
      sessionMarkUnread: (i) => api.sessions.markUnread.mutate(i),
      issueMarkRead: (i) => api.issues.markRead.mutate(i),
      issueMarkUnread: (i) => api.issues.markUnread.mutate(i),
      issueSetTucked: (i) => api.issues.setTucked.mutate(i),
    },
    onApplied: args.onApplied,
    // A definitively-refused entry can never sync AS IT IS — but it is no longer
    // dropped (POD-316), so the old copy ("and dropped") had become a lie about
    // work that is in fact sitting in the recovery surface. A toast that tells
    // you your writing is gone, when it is recoverable two clicks away, is worse
    // than no toast: it teaches people to re-type instead of to look.
    onPoison: (entry) => {
      args.onDropped?.(entry)
    },
    onDeadLetter: (parked) => {
      args.notices.error(
        `A queued change (${parked.entry.kind}) needs your attention — ${reasonSummary(parked.reason.code)}`,
      )
      args.onDeadLetter?.(parked)
    },
  })
}
