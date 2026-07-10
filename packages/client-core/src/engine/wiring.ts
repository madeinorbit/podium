/**
 * Engine transport + write-path wiring (#262 [spec:SP-3fe2]): constructs the
 * SocketHub (metadata delta mode, persist-after-apply into the replica) and the
 * Outbox (durable offline write queue over the replica's storage). Extracted
 * verbatim from react/provider.tsx so the engine — and any non-React client —
 * shares ONE construction path with zero React involvement.
 */

import type { WorkState } from '@podium/protocol'
import { SocketHub } from '@podium/terminal-client'
import type { PodiumClientApi } from '../api'
import { Outbox, type OutboxEntry, platformIsOnline, platformOnlineEvents } from '../outbox'
import type { Replica } from '../replica/replica'
import type { StoreNotices } from './types'

/** Outboxed mutation kinds → their tRPC inputs (docs/spec/outbox-write-path.md
 *  §2.3). Each executor replays with the entry's stable mutationId, so the
 *  server dedupes across reload/reconnect. Pins/tab-orders/sidebar-settings
 *  stay direct (low offline value); sendText stays direct too — live chat must
 *  fail fast, not silently queue. */
export type OutboxKinds = {
  resumeAndSend: { sessionId: string; text: string }
  rename: { sessionId: string; name: string }
  setArchived: { sessionId: string; archived: boolean }
  setWorkState: { sessionId: string; workState: WorkState | null }
  snoozeSet: { sessionId: string; until: string | null }
  snoozeClear: { sessionId: string }
  sessionMarkRead: { sessionId: string }
  sessionMarkUnread: { sessionId: string }
  issueMarkRead: { id: string }
  issueMarkUnread: { id: string }
}

/** SocketHub construction seam — injectable so engine unit tests run a fake hub. */
export type CreateHub = (opts: ConstructorParameters<typeof SocketHub>[0]) => SocketHub

export function createEngineHub(args: {
  wsClientUrl: string
  api: PodiumClientApi
  replica: Replica
  onFatalError: (message: string) => void
  createHub?: CreateHub
}): SocketHub {
  const { api, replica } = args
  const make: CreateHub = args.createHub ?? ((opts) => new SocketHub(opts))
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
   *  awaiting-truth stage (retirement rule (a), overlay.ts). */
  onApplied?: (entry: OutboxEntry) => void
  /** Poison drop — fired AFTER the toast; the engine repaints without the
   *  entry's overlay (retirement rule (b)). */
  onDropped?: (entry: OutboxEntry) => void
}): Outbox<OutboxKinds> {
  const { api } = args
  return new Outbox<OutboxKinds>({
    isOnline: platformIsOnline,
    onlineEvents: platformOnlineEvents(),
    // One persistence layer: the queue persists into a replica collection
    // (cross-tab consistent via storage events; in-memory in private mode);
    // the drain/retry/poison logic is unchanged.
    storage: args.replica.outboxStorage(),
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
    },
    onApplied: args.onApplied,
    // A poison entry (server-side validation reject) can never sync — it's
    // dropped, and the toast is the honesty about that.
    onPoison: (entry) => {
      args.notices.error(`A queued change (${entry.kind}) was rejected by the server and dropped`)
      args.onDropped?.(entry)
    },
  })
}
