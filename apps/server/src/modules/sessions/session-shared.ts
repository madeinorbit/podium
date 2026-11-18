/**
 * Constants genuinely shared by the session modules (POD-1396).
 *
 * WHY THESE LIVE HERE. Values with more than one consumer and no single owner —
 * not representations (those live where they are produced; see SessionSpawnResult
 * on session-start.ts) and not private to one collaborator.
 *
 * `DEFAULT_GEOMETRY` is read by session-start (spawn frame), lifecycle (headless
 * port) and relay. `APPLIED_MUTATIONS_MAX_AGE_MS` is the receipt horizon the
 * maintenance service hands the janitor's prune and the receipt-retention test
 * imports. lifecycle re-exports both so existing call sites are unaffected.
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
/*
 * WHY 30 DAYS AND NOT 7 (POD-7035). A receipt must outlive every replay that can
 * still reach it, strictly: ADR 3 D11's `OUTBOX_MAX_AGE_MS + SKEW_MARGIN_MS` is 14
 * + 2 = 16 days. At 7 days a write queued offline on day 1 and drained on day 10
 * would find no receipt and run a second time. What made the table large was
 * not the horizon but bulky results (the ledger now stores a digest above
 * `RECEIPT_RESULT_MAX_BYTES`) and a prune that ran only at boot (now the
 * janitor's, in batches).
 */
export const APPLIED_MUTATIONS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
