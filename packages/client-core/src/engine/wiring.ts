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
import { advanceCursor, identityVerdict } from '../replica/feed'
import type { Replica } from '../replica/replica'
import { type FeedSinkPort, SocketHub } from '../transport'
import type { StoreNotices } from './types'

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
    // [POD-856] Offer CAP_ISSUES_NORMALIZED: this client reads issues from the
    // replica's normalized projections (issueProjection/issueDep/repo joined into
    // IssueView, D7.3) rather than the embedded IssueWire, so a session change
    // costs it zero issue-wire work. The server emits the projections
    // unconditionally as of the POD-856 activation; offering the cap is what makes
    // the hub POPULATE this client's issueProjections/issueDeps/repos collections
    // (without it they stay empty and the views have nothing to read).
    issuesNormalized: true,
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
      // ADR 2 D7 rung 4 — the feed identity is not the one we hold. Judged
      // BEFORE the install, because the batch about to be installed belongs to a
      // timeline our rows do not: `seq === cursor + 1` across an epoch bump is a
      // coincidence, and welding the two together is the exact silent corruption
      // D1 exists to catch (restore the authority from a backup, and
      // changesSince answers "up to date" over phantom rows forever).
      //
      // The hub still heals on a bare seq (rungs 0/1); this is the identity half,
      // enforced at the replica seam where the held triple actually lives. POD-796
      // moves the whole ladder onto the sync path when it cuts the wire over.
      const held = replica.getFeedCursor()
      const mismatch = identityVerdict(held, state) === 'mismatch'
      if (mismatch) {
        console.warn(
          `[podium] feed identity changed (${held.feedId}/${held.epoch} → ${state.feedId}/${state.epoch}) — ` +
            'discarding the replica cache and re-bootstrapping; queued writes are kept',
        )
      }
      // The discard and the install are ONE batch, and that is D7's
      // "never blank the UI before the replacement state is installed" — not a
      // micro-optimisation. `resetCache` batches internally, so on its own it
      // flushes a notification at ZERO rows and every subscriber paints an empty
      // board for a frame before the real state arrives. Nesting both under one
      // batch coalesces them into a single wake against the FINAL state, which
      // is the atomic swap D6 asks for, at this seam.
      replica.batch(() => {
        // Discard the CACHE, keep the OUTBOX (D7). The state being installed is
        // the authority's, taken at the new identity, so it replaces what we
        // drop in the same turn.
        if (mismatch) replica.resetCache()
        replica.applySnapshot('sessions', state.sessions)
        replica.applySnapshot('issues', state.issues)
        // The three POD-796/POD-822 kinds ride the same atomic batch [POD-822].
        // Empty arrays until the authority's flag is on and this client offered
        // the cap — an empty applySnapshot is the correct rollback (it removes
        // any rows a previously-enabled flag left behind), and the views read
        // from these collections regardless of whether they are populated.
        replica.applySnapshot('issueProjections', state.issueProjections)
        replica.applySnapshot('issueDeps', state.issueDeps)
        replica.applySnapshot('repos', state.repos)
        replica.applySnapshot('conversations', state.conversations)
        replica.applySnapshot('automations', state.automations)
        replica.applySnapshot('automationRuns', state.automationRuns)
      })
      // The cursor is the TRIPLE (D1). An authority that stamps nothing leaves
      // the identity we already hold intact rather than blanking it — see
      // advanceCursor on why blanking loops against a mixed-version authority.
      replica.setFeedCursor(
        advanceCursor(replica.getFeedCursor(), {
          kind: 'snapshot',
          cursor: state.cursor,
          stamp: state,
        }),
      )
    },
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
