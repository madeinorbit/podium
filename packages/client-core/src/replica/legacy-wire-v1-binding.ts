import { advanceCursor, identityVerdict } from './feed'
import type { LegacyMetadataAppliedState } from './legacy-wire-v1-feed'
import type { Replica } from './replica'

/**
 * Installs a legacy wire-v1 feed projection into the kernel Replica.
 *
 * Feed identity, position and replacement semantics stay on the Replica side of
 * the socket port. A changed identity discards only cached authority state; the
 * durable outbox survives and the replacement is installed atomically.
 */
export function applyLegacyMetadataState(
  replica: Replica,
  state: LegacyMetadataAppliedState,
): void {
  const held = replica.getFeedCursor()
  const mismatch = identityVerdict(held, state) === 'mismatch'
  if (mismatch) {
    console.warn(
      `[podium] feed identity changed (${held.feedId}/${held.epoch} → ${state.feedId}/${state.epoch}) — ` +
        'discarding the replica cache and re-bootstrapping; queued writes are kept',
    )
  }

  // Discard and replacement are one notification turn: consumers never observe
  // the empty middle, while the durable outbox remains outside the cache reset.
  replica.batch(() => {
    if (mismatch) replica.resetCache()
    replica.applySnapshot('sessions', state.sessions)
    replica.applySnapshot('issues', state.issues)
    replica.applySnapshot('issueProjections', state.issueProjections)
    replica.applySnapshot('issueDeps', state.issueDeps)
    replica.applySnapshot('repos', state.repos)
    replica.applySnapshot('conversations', state.conversations)
    replica.applySnapshot('automations', state.automations)
    replica.applySnapshot('automationRuns', state.automationRuns)
  })

  replica.setFeedCursor(
    advanceCursor(replica.getFeedCursor(), {
      kind: 'snapshot',
      cursor: state.cursor,
      stamp: state,
    }),
  )
}
