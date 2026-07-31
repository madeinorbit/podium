/**
 * Issue-tracker CONCURRENCY POLICY — is a write based on current truth?
 *
 * The expected-revision precondition of ADR 1 (`exp-rev` rows) / ADR 2 D3 (the
 * token) / ADR 3 D13 (the envelope field), as a pure decision. Sibling of
 * `authorize` in issue-authz.ts and split the same way: the decision is PURE and
 * lives here; the transport-shaped enforcement (which throws a TRPCError
 * carrying the conflict) stays in apps/server.
 *
 * Deliberately typed on plain integers rather than @podium/model's `Revision`
 * schema: this package is a zero-dependency leaf. The vocabulary lives at the
 * wire layer that parses it; the comparison does not need it.
 */

/**
 * The outcome of checking a caller's `expectedRevision` against the authority's
 * current one. Three cases, because "cannot tell" is not "fine":
 *
 * - `ok` — no precondition supplied, or it matches. Proceed.
 * - `stale` — the entity moved since the caller read it. The write is refused
 *   and the CURRENT revision rides along, so a client can rebase and retry
 *   rather than guess (ADR 3 D13.3: a reason the UI can render).
 * - `unverifiable` — a precondition was supplied but the entity carries no
 *   revision to check it against (an issue mirrored from an upstream hub, or a
 *   row written by an authority predating ADR 2 D3). Also a refusal: a caller
 *   asked for a guarantee we cannot provide, and applying anyway would silently
 *   downgrade the write to last-write-wins — precisely the "fails open" bug
 *   class where a gate waves through what it does not understand.
 */
export type RevisionCheck =
  | { kind: 'ok' }
  | { kind: 'stale'; expected: number; actual: number }
  | { kind: 'unverifiable'; expected: number }

/**
 * Decide whether a write carrying `expected` may apply to an entity currently at
 * `actual`.
 *
 * `expected == null` ⇒ `ok`: the field is optional across the Issues seed
 * (ADR 3 D13's envelope is declared before any client can fill it — see
 * RevisionedCommandEnvelope), so an omitted precondition means "no precondition"
 * and keeps today's last-write-wins. It does NOT mean "check skipped because
 * something went wrong".
 */
export function checkExpectedRevision(
  expected: number | undefined,
  actual: number | undefined,
): RevisionCheck {
  if (expected == null) return { kind: 'ok' }
  if (actual == null) return { kind: 'unverifiable', expected }
  if (actual !== expected) return { kind: 'stale', expected, actual }
  return { kind: 'ok' }
}
