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

import type { ConversationDiagnosticWire } from '@podium/model'
import { Authority, FeedIdentityRegistry, Ledger, type FeedIdentity } from '@podium/sync'
import { SessionStore } from '../store'
import { FeedServing } from './feed-serving'

export interface FeedTestPlumbing {
  readonly serving: FeedServing
  readonly ledger: Ledger
  readonly authority: Authority
  readonly store: SessionStore
}

export function feedTestPlumbing(
  opts: { diagnostics?: () => ConversationDiagnosticWire[] } = {},
): FeedTestPlumbing {
  const store = new SessionStore(':memory:')
  const ledger = new Ledger({
    repo: store.sync,
    now: () => 1_000,
    transact: (fn) => store.transact(fn),
  })
  let minted = 0
  let identity: FeedIdentity | null = null
  const serving = new FeedServing({
    authority: ledger.authority,
    identity: new FeedIdentityRegistry(
      {
        readIdentity: () => identity,
        writeIdentity: (next) => {
          identity = next
        },
      },
      () => `id-${(minted += 1)}`,
    ),
    retention: { minAvailableSeq: () => store.sync.minChangeSeq() },
    diagnostics: opts.diagnostics ?? (() => []),
  })
  return { serving, ledger, authority: ledger.authority, store }
}
