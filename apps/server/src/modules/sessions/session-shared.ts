/**
 * Constants genuinely shared by the session modules (POD-1396).
 *
 * WHY THESE LIVE HERE. Values with more than one consumer and no single owner —
 * not representations (those live where they are produced; see SessionSpawnResult
 * on session-start.ts) and not private to one collaborator.
 *
 * `DEFAULT_GEOMETRY` is read by session-start (spawn frame), lifecycle (headless
 * port) and relay. `APPLIED_MUTATIONS_MAX_AGE_MS` is the prune horizon the
 * repository uses and the receipt-retention test imports. lifecycle re-exports
 * both so existing call sites are unaffected.
 */

import type { Geometry } from '@podium/model'

/** The geometry a session is born with, before any client reports a real one. */
export const DEFAULT_GEOMETRY: Geometry = { cols: 80, rows: 24 }

/**
 * Idempotency records outlive any sane replay horizon, then get pruned. ADR 2 D11
 * owns this number and this is its prune site.
 *
 * EXPORTED because ADR 3 D11.3 requires the outbox age inequality to IMPORT it
 * rather than copy `30d` into the check. See lifecycle.ts re-export for the
 * receipt-retention test that asserts the invariant on this side of the
 * packages/apps boundary.
 */
export const APPLIED_MUTATIONS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

