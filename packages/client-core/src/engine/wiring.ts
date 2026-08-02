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
