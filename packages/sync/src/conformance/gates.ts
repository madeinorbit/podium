/**
 * Phase-2's sync GATE CONDITIONS, as data (POD-373).
 *
 * The human decision of 2026-07-29 (`docs/multi-user-readiness.md` header) is §3.1
 * option C's mechanism with option B's default, and it says one thing about this
 * file explicitly: "the machinery is **load-bearing from day one, not inert** …
 * Conformance coverage for them is a gate condition, not a follow-up." ADR 2
 * Amendment 1 D17 says the same from the protocol side.
 *
 * So the gates are a CLOSED SET here rather than a sentence in a brief, and
 * `assertGatesCovered` is a TOTALITY TEST over it: an instantiation that skips a
 * gate fails, and a gate with no test fails. "Registered as a gate condition"
 * therefore means something a build can check, which is the whole difference
 * between a gate and a report.
 *
 * The instrument can say YES and NO both ways, and that is asserted in
 * `gates.test.ts` rather than assumed — a coverage tracker that cannot report a
 * miss is indistinguishable from one that found none.
 */

/**
 * Every gate condition Phase 2 owes, keyed by a stable id.
 *
 * The id is what a test names and what the totality test counts, so it is
 * deliberately not the test's prose title: renaming a test must not silently
 * un-register a gate.
 */
export const PHASE_2_SYNC_GATES = {
  // ── The brief's base list: one suite, every instantiation ──────────────────
  'base/disconnect-stale-visible': 'ADR 2 D7 — disconnected keeps its slice, marked stale, never blank',
  'base/gap-heals': 'ADR 2 D7 rung 1 — a gap heals through changesSince and resolves downward',
  'base/bootstrap-chunked': 'ADR 2 D6 / Amendment 1 D15 — chunked, paced, per-principal bootstrap',
  'base/cold-start': 'ADR 2 D7 — a client with no cursor re-bootstraps (rung 2, cause cold-start)',
  'base/offline-writes-drain': 'ADR 3 D9 — writes queued offline drain on reconnect',
  'base/duplicate-delivery': 'ADR 2 D13 — a re-delivered frame is idempotent; the cursor never regresses',
  'base/rejection-dead-letter': 'ADR 3 D9/D10 — a definitive refusal dead-letters with a recovery plan, no retry loop',
  'base/crash-between-writes': 'ADR 2 D10 — crash between entity, cursor and outbox writes: PRE or POST, never torn',
  'base/quota-exhaustion': 'ADR 6 D4.4 — a denied durable write surfaces; it never partially applies and never loses work',

  // ── The four cases the ADRs assign to this suite BY NAME ───────────────────
  'adr/restore-then-stale-client': 'ADR 2 D1 — restore, keep writing, stale client reconnects at the SAME seq',
  'adr/reconnect-storm': 'ADR 2 D6 — N replicas bootstrapping at once; bootstrap paces, yields, never owns the loop',
  'adr/offline-writes-across-epoch-bump': 'ADR 2 D7 — queued writes survive an epoch bump: they drain or surface, none vanish',
  'adr/slow-consumer-demoted-converges': 'ADR 2 D9 — demote-to-resync CONVERGES, not merely survives',

  // ── The seven scoped multi-user gates (readiness §3.1, POD-1077) ───────────
  'scoped/grant-mid-session': 'Amendment 1 D14.2 — a row becomes visible to a live replica; contiguity intact',
  'scoped/revoke-mid-session': 'Amendment 1 D14.1/D14.5 — evict is NOT a deletion and stays distinguishable from remove',
  'scoped/gap-heal-exact-slice': 'Amendment 1 D13/D16.1 — a scoped heal converges on EXACTLY its slice, never more',
  'scoped/revoked-offline-with-queued-writes': 'ADR 3 D8/D16 — live re-authorization refuses definitively and surfaces recovery',
  'scoped/slow-scoped-replica-converges': 'ADR 2 D9 + D15 — demote-to-resync still converges when the resync is SCOPED',
  'scoped/crash-with-watermark-in-flight': 'ADR 2 D10 + D13 — one-transaction rule holds; the watermarked range is not a gap',
  'scoped/rescope-keeps-the-outbox': 'ADR 2 D7 + D14.4 — rung 2 discards the cache, re-bootstraps, KEEPS the outbox',

  // ── Cross-cutting assertions the WHOLE suite carries under multi-user ──────
  'cross/no-existence-oracle': 'readiness §3.1.5 / ADR 3 D20 — invisible target fails IDENTICALLY to a nonexistent id',
  'cross/watermarks-are-not-gaps': 'Amendment 1 D13.4 — a watermark-only stretch never heals and never grows state',
  'cross/attribution-survives-every-hop': 'readiness §3.1.3 A3 / ADR 3 D17 — actor + on-behalf-of survive replay, duplicates, crash, dead-letter',
  'cross/two-principals-one-authority': 'readiness §3.1 — two principals with DIFFERENT slices against one authority',
  'cross/no-instance-id': 'ADR 1 D5 — multi-user is not multi-tenancy: no instance_id in fixtures or assertions',
} as const

export type Phase2SyncGate = keyof typeof PHASE_2_SYNC_GATES

export const PHASE_2_SYNC_GATE_IDS = Object.keys(PHASE_2_SYNC_GATES) as readonly Phase2SyncGate[]

/**
 * Records which gates an instantiation actually exercised.
 *
 * One tracker per instantiation, not one global: "green in CI against the
 * in-memory instantiation" and "POD-374 runs the same suite" are two claims, and
 * a shared counter would let the second borrow the first's coverage.
 */
export class GateLedger {
  private readonly seen = new Map<Phase2SyncGate, number>()

  constructor(readonly instantiation: string) {}

  /** Called by the test that satisfies a gate. Returns its id so it can be used in a title. */
  cover(gate: Phase2SyncGate): Phase2SyncGate {
    this.seen.set(gate, (this.seen.get(gate) ?? 0) + 1)
    return gate
  }

  covered(): readonly Phase2SyncGate[] {
    return [...this.seen.keys()]
  }

  times(gate: Phase2SyncGate): number {
    return this.seen.get(gate) ?? 0
  }

  /** Gates with no test. The whole point of the ledger. */
  missing(): readonly Phase2SyncGate[] {
    return PHASE_2_SYNC_GATE_IDS.filter((gate) => !this.seen.has(gate))
  }
}

/**
 * Throws unless every gate was exercised. Called from the suite's `afterAll`.
 *
 * It throws rather than returning a boolean so a caller cannot forget to look at
 * the answer — the failure mode of a checker whose result is ignored is
 * indistinguishable from a checker that always passes.
 */
export function assertGatesCovered(ledger: GateLedger): void {
  const missing = ledger.missing()
  if (missing.length === 0) return
  throw new Error(
    `${ledger.instantiation}: ${missing.length} Phase-2 sync gate condition(s) have no test:\n` +
      missing.map((gate) => `  - ${gate} — ${PHASE_2_SYNC_GATES[gate]}`).join('\n'),
  )
}
