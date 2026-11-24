import { StoreModelLedger as Ledger } from '../test-support/model-ledger'
/**
 * A REAL serving edge over an in-memory store, for tests (POD-1203).
 *
 * Deliberately not a stub. A `FeedServing` fake would answer every call and
 * assert nothing — POD-732's "an empty router satisfies every absence claim
 * perfectly" — and the properties tests need from this collaborator (a bootstrap
 * that reflects the log, a delta that follows it contiguously, a v1 peer seeing
 * full lists) are exactly the ones a stub cannot have. What is faked here is the
 * STORE, and only the store.
 *
 * The mint is a counter with a non-numeric prefix: `assertOpaqueEpoch` refuses a
 * bare decimal (ADR 2 D1 forbids a counter), and a test that needs a stable epoch
 * across a restart needs one it can predict.
 */

import type { ConversationDiagnosticWire, UserId, UserRole } from '@podium/model'
import { firstAdminMemberId } from '@podium/model'
import { type SubscriberId, SubscriptionRegistry } from '@podium/protocol'
import {
  type Authority,
  type FeedIdentity,
  FeedIdentityRegistry,
  type FeedRetentionPort,
  type FeedVisibilityPolicy,
  type PostCommitFollowUpPort,
  type VisibilityAnchorPort,
} from '@podium/sync'
import type { SessionStore } from '../store'
import { afterCommit, applyAfterCommit, spanOpen } from '../store/executor/executor'
import { openTestStore } from '../test-support/open-test-store'
import { type ClientPrincipal, userClientPrincipal } from './client-principal'
import { FeedServing } from './feed-serving'

export interface FeedTestPlumbing {
  readonly serving: FeedServing
  readonly ledger: Ledger
  readonly authority: Authority
  readonly store: SessionStore
  readonly subscriptions: SubscriptionRegistry
  readonly routingPrincipal: (peerId: string, user?: UserId, role?: UserRole) => ClientPrincipal
}

export async function feedTestPlumbing(
  opts: {
    diagnostics?: () => ConversationDiagnosticWire[]
    onVisibilityChanged?: (subscriberIds: readonly SubscriberId[]) => void
    /** Override for tests whose visibility state is held outside SessionStore. */
    authorizationRevision?: () => number
    /**
     * The policy the Authority evaluates with. OMITTED keeps `Ledger`'s own
     * default (`DeviceGradeUnscopedPolicy`), which is what every pre-POD-1497
     * caller of this plumbing relies on — those suites are about framing, not
     * about scoping, and forcing a scope on them would change what they test.
     *
     * A per-user suite passes `GrantEdgeVisibilityPolicy`, which is the class
     * `relay.ts` installs. Passing the real class rather than a test-local
     * stand-in is the whole point: a hand-written policy object here would
     * certify the fixture's rules, not the product's (POD-1497).
     */
    visibility?: FeedVisibilityPolicy
    /** Goes with `visibility` — D14.3's grant-row → per-principal derivation. */
    anchors?: VisibilityAnchorPort
    /**
     * ADR 2 D5's floor. OMITTED reads the store, which is the truth for every
     * suite that only ever appends.
     *
     * A suite about COMPACTION cannot get there by appending: this store never
     * prunes, so its floor is 1 forever and the rung that fires when a cursor
     * falls below the retained range would be untestable — present in the code,
     * proven by nothing. Injecting the floor is injecting the one fact the store
     * cannot produce, not stubbing the collaborator under test.
     */
    retention?: FeedRetentionPort
    /**
     * POD-7585 — another PROCESS over the same database: its own Ledger,
     * Authority and serving edge over this store. Omitted opens a fresh store.
     */
    store?: SessionStore
    /**
     * POD-7585 — where a commit's delivery pass is queued. Omitted queues it
     * after the commit as `relay.ts` does; a test that drops the step is a
     * process that exited between the commit and its pass.
     */
    postCommit?: PostCommitFollowUpPort
  } = {},
): Promise<FeedTestPlumbing> {
  const store = opts.store ?? (await openTestStore(':memory:'))
  const ledger = new Ledger(store, {
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
    ...(opts.anchors ? { anchors: opts.anchors } : {}),
    repo: store.sync,
    accessMoves: store.sync,
    now: () => 1_000,
    transact: async (fn) => await store.transact(fn),
    // Match relay.ts: this is a real transactional store, so queued delivery
    // must not inherit the transaction that is about to close.
    postCommit: opts.postCommit ?? ((step, label) => afterCommit(step, label)),
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
  })
  let minted = 0
  let identity: FeedIdentity | null = null
  const subscriptions = new SubscriptionRegistry()
  const serving = new FeedServing({
    workspaceId: store.workspaceId,
    authority: ledger.authority,
    identity: new FeedIdentityRegistry(
      {
        readIdentity: async () => identity,
        writeIdentity: async (next) => {
          identity = next
        },
      },
      () => {
        minted += 1
        return `id-${minted}`
      },
    ),
    retention: opts.retention ?? {
      minAvailableSeq: async () => await store.sync.minAvailableSeq(),
    },
    accessMoves: store.sync,
    subscriptions,
    ...(opts.onVisibilityChanged ? { onVisibilityChanged: opts.onVisibilityChanged } : {}),
    diagnostics: opts.diagnostics ?? (() => []),
  })
  // As `relay.ts` boots: replay what no delivery pass recorded before serving.
  await ledger.authority.catchUpAccessMoves()
  return {
    serving,
    ledger,
    authority: ledger.authority,
    store,
    subscriptions,
    routingPrincipal: (peerId, user = firstAdminMemberId(), role = 'admin') =>
      userClientPrincipal(peerId, user, role),
  }
}
