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
import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { type SubscriberId, SubscriptionRegistry } from '@podium/protocol'
import {
  type Authority,
  type FeedIdentity,
  FeedIdentityRegistry,
  type FeedVisibilityPolicy,
  Ledger,
  type VisibilityAnchorPort,
} from '@podium/sync'
import { SessionStore } from '../store'
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

export function feedTestPlumbing(
  opts: {
    diagnostics?: () => ConversationDiagnosticWire[]
    onVisibilityChanged?: (subscriberIds: readonly SubscriberId[]) => void
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
  } = {},
): FeedTestPlumbing {
  const store = new SessionStore(':memory:')
  const ledger = new Ledger({
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
    ...(opts.anchors ? { anchors: opts.anchors } : {}),
    repo: store.sync,
    now: () => 1_000,
    transact: (fn) => store.transact(fn),
  })
  let minted = 0
  let identity: FeedIdentity | null = null
  const subscriptions = new SubscriptionRegistry()
  const serving = new FeedServing({
    authority: ledger.authority,
    identity: new FeedIdentityRegistry(
      {
        readIdentity: () => identity,
        writeIdentity: (next) => {
          identity = next
        },
      },
      () => {
        minted += 1
        return `id-${minted}`
      },
    ),
    retention: { minAvailableSeq: () => store.sync.minChangeSeq() },
    subscriptions,
    ...(opts.onVisibilityChanged ? { onVisibilityChanged: opts.onVisibilityChanged } : {}),
    diagnostics: opts.diagnostics ?? (() => []),
  })
  return {
    serving,
    ledger,
    authority: ledger.authority,
    store,
    subscriptions,
    routingPrincipal: (peerId, user = FIRST_ADMIN_USER_ID, role = 'admin') =>
      userClientPrincipal(peerId, user, role),
  }
}
