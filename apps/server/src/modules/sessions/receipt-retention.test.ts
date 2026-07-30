/**
 * ADR 3 D11's inequality, asserted against the LIVE receipt constant.
 *
 * `OUTBOX_MAX_AGE_MS + SKEW_MARGIN_MS < RECEIPT_RETENTION_MS`
 *
 * Why this file lives HERE, in apps/server, rather than beside the outbox kernel
 * that owns the left-hand side: D11.3 requires the check to IMPORT the receipt
 * constant, and `packages/*` may not import `apps/*` (boundary rule 4). The
 * receipt constant's home is its prune site, `service.ts` in this directory, so
 * the invariant is asserted on this side of the boundary. The alternative —
 * re-declaring `30 * 24 * 60 * 60 * 1000` inside `packages/sync` — is exactly the
 * failure D11.3 names: a copy that keeps passing after somebody tunes the real
 * constant (the POD-770 class, where a spec promised 14d while the code shipped
 * 3d).
 *
 * What breaks if the inequality inverts: an outbox entry that outlives its
 * receipt replays as a FRESH command past the dedupe horizon. That is not
 * "idempotent-ish" — `sessions.sendText` double-types into a live PTY. Expiry at
 * the replica is how the send is refused, and it can only refuse in time if the
 * entry dies before the receipt does.
 */

import {
  assertUnderReceiptRetention,
  holdsAgainstReceiptRetention,
  OUTBOX_HORIZON_MS,
  OUTBOX_MAX_AGE_MS,
  SKEW_MARGIN_MS,
} from '@podium/sync'
import { describe, expect, it } from 'vitest'
import { APPLIED_MUTATIONS_MAX_AGE_MS as RECEIPT_RETENTION_MS } from './service'

const DAY = 24 * 60 * 60 * 1000

describe('ADR 3 D11 — the outbox horizon stays strictly below receipt retention', () => {
  it('holds against the live receipt constant, imported and not copied', () => {
    // The assertion form, so a violation reads as the ADR rule it breaks.
    expect(() => assertUnderReceiptRetention(RECEIPT_RETENTION_MS)).not.toThrow()
    expect(OUTBOX_MAX_AGE_MS + SKEW_MARGIN_MS).toBeLessThan(RECEIPT_RETENTION_MS)
  })

  it('is wired to the REAL constant: a receipt retention equal to the horizon fails', () => {
    // The instrument has to be able to say NO before its YES above means
    // anything. Both directions are probed at the boundary, because D11 says
    // STRICTLY below: equality means an entry can reach the Authority in the same
    // instant its receipt is pruned.
    expect(holdsAgainstReceiptRetention(OUTBOX_HORIZON_MS)).toBe(false)
    expect(holdsAgainstReceiptRetention(OUTBOX_HORIZON_MS + 1)).toBe(true)
    expect(() => assertUnderReceiptRetention(OUTBOX_HORIZON_MS)).toThrow(/not strictly below/)
    // And it is genuinely reading this module's value: were the import a copy of
    // 30d, the arithmetic below would still pass while the real prune moved.
    expect(RECEIPT_RETENTION_MS).toBe(30 * DAY)
  })

  it('carries D10s own values, so the inequality is about the shipped numbers', () => {
    expect(OUTBOX_MAX_AGE_MS).toBe(14 * DAY)
    // "at least 2 days", so this is a floor and not an equality.
    expect(SKEW_MARGIN_MS).toBeGreaterThanOrEqual(2 * DAY)
  })

  it('leaves room for the skew margin to grow before the inequality bites', () => {
    // The slack is the reviewable fact: 16d against 30d. If a future change wants
    // a longer client queue it must raise receipt retention FIRST (ADR 2
    // amendment), then the outbox age — D11.6, never the other way round.
    expect(RECEIPT_RETENTION_MS - OUTBOX_HORIZON_MS).toBe(14 * DAY)
  })
})
