/**
 * Engine transport + write-path wiring (#262 [spec:SP-3fe2]): constructs the
 * SocketHub (metadata delta mode, persist-after-apply into the replica) and the
 * Outbox (durable offline write queue over the replica's storage). Extracted
 * verbatim from react/provider.tsx so the engine — and any non-React client —
 * shares ONE construction path with zero React involvement.
 */

import type { SessionId, WorkState } from '@podium/model'
import { type FeedSinkPort, SocketHub } from '@podium/terminal-client'
import type { PodiumClientApi } from '../api'
import {
  Outbox,
  type OutboxDeadLetterEntry,
  type OutboxEntry,
  platformIsOnline,
  platformOnlineEvents,
} from '../outbox'
import type { Replica } from '../replica/replica'
import type { StoreNotices } from './types'
import { reasonSummary } from '../outbox-recovery-copy'

/** Outboxed mutation kinds → their tRPC inputs (docs/spec/outbox-write-path.md
 *  §2.3). Each executor replays with the entry's stable mutationId, so the
 *  server dedupes across reload/reconnect. Pins/tab-orders/sidebar-settings
 *  stay direct (low offline value); sendText stays direct too — live chat must
 *  fail fast, not silently queue. */
export type OutboxKinds = {
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

/** SocketHub construction seam — injectable so engine unit tests run a fake hub. */
export type CreateHub = (opts: ConstructorParameters<typeof SocketHub>[0]) => SocketHub

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
   * THE BRANCH IS TOTAL, and the `else` half is why. The v1 options below are
   * not merely unnecessary on the feed path — `fetchChangesSince` is REFUSED
   * alongside `feed` at SocketHub construction, and `onMetadataApplied` would
   * drive `applySnapshot` into a replica whose kernel facade throws on it. So
   * this is not "add a field": the two option sets are mutually exclusive, and
   * they are written as one ternary so no future edit can hand a hub both
   * halves and discover the refusal at runtime.
   */
  feed?: FeedSinkPort
}): SocketHub {
  const { api, replica } = args
  const make: CreateHub = args.createHub ?? ((opts) => new SocketHub(opts))
  if (args.feed !== undefined) {
    return make({
      url: args.wsClientUrl,
      viewport: { cols: 80, rows: 24, dpr: globalThis.devicePixelRatio ?? 1 },
      onError: (message) => args.onFatalError(message),
      feed: args.feed,
    })
  }
  return make({
    url: args.wsClientUrl,
    viewport: { cols: 80, rows: 24, dpr: globalThis.devicePixelRatio ?? 1 },
    onError: (message) => args.onFatalError(message),
    // Opts the hub into metadata delta mode (docs/spec/oplog-read-path.md):
    // session/issue/conversation updates arrive as per-entity oplog changes,
    // with (re)connect catch-up healed through this query.
    fetchChangesSince: (cursor) => api.sync.changesSince.query({ cursor }),
    // Resume across reloads: the replica's persisted cursor makes the first
    // catch-up a delta instead of a full snapshot (null on a cold client).
    initialCursor: replica.getCursor(),
    // Persist-after-apply: mirror every applied metadata batch into the
    // replica, entities first, cursor after (replica upholds the ordering).
    // The batch (#262 review) makes the whole application — bootstrap snapshot,
    // heal snapshot, or live delta, across all three kinds — atomic from the
    // engine reactions' viewpoint: row subscribers fire once per kind against
    // the FINAL state, never against the transient list between applySnapshot's
    // delete and upsert transactions (which used to trip the worktree fallback
    // + a spurious URL rewrite).
    onMetadataApplied: (state) => {
      replica.batch(() => {
        replica.applySnapshot('sessions', state.sessions)
        replica.applySnapshot('issues', state.issues)
        replica.applySnapshot('conversations', state.conversations)
        replica.applySnapshot('automations', state.automations)
        replica.applySnapshot('automationRuns', state.automationRuns)
      })
      replica.setCursor(state.cursor)
    },
  })
}

/** Durable write path for the covered mutations. The queue doubles as the
 *  optimistic overlay (#263: the outbox IS the overlay — see overlay.ts): a
 *  pending entry paints its patch over the replica's server truth, so an
 *  offline write both survives a reload AND keeps painting after it, then
 *  replays (deduped by mutationId) on reconnect. */
export function createEngineOutbox(args: {
  api: PodiumClientApi
  replica: Replica
  notices: StoreNotices
  /** Drain success — the engine hands the entry's overlay to the
   *  awaiting-truth stage (retirement rule (a), overlay.ts). Returning true
   *  keeps the entry durably in storage as state:'awaiting-truth' (#263
   *  review finding 1) until the engine retires it. */
  onApplied?: (entry: OutboxEntry) => unknown
  /** A definitive refusal — the engine repaints without the entry's overlay
   *  (retirement rule (b)). The entry itself is PARKED, not dropped; this is
   *  only the overlay's retirement. */
  onDropped?: (entry: OutboxEntry) => void
  /** The entry parked for recovery, with its reason code. Fired after the
   *  toast. */
  onDeadLetter?: (parked: OutboxDeadLetterEntry) => void
}): Outbox<OutboxKinds> {
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
