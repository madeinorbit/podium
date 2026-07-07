/**
 * The issue closed/stage machine — PURE derivations and transition validation,
 * extracted from apps/server IssueService so every runtime (server, CLI, web
 * viewmodels) shares ONE definition of "closed", "deferred", "blocked", "ready"
 * and one close/reopen normalization. No IO: callers pass rows and clocks in.
 */

/** The minimal row shape the closed predicate reads. Structural on purpose —
 *  it matches IssueRow, IssueWire and hub-mirrored shapes alike. */
export interface IssueClosedFields {
  stage: string
  closedReason?: string | null
}

/** THE closed predicate: done-stage or an explicit close reason. */
export function isIssueClosed(row: IssueClosedFields): boolean {
  return row.stage === 'done' || row.closedReason != null
}

/** Deferred = snoozed until a future instant. `nowIso` injected for testability
 *  (ISO-8601 strings compare lexicographically in timestamp order). */
export function isIssueDeferred(row: { deferUntil?: string | null }, nowIso: string): boolean {
  return row.deferUntil != null && row.deferUntil > nowIso
}

/**
 * blocked = open AND ≥1 `blocks` dep whose target issue is not closed.
 * The caller resolves the row's `blocks` dep targets (undefined = dangling
 * edge, which does NOT block — the target is gone).
 */
export function isIssueBlocked(
  row: IssueClosedFields,
  blocksTargets: ReadonlyArray<IssueClosedFields | undefined>,
): boolean {
  if (isIssueClosed(row)) return false
  return blocksTargets.some((target) => (target ? !isIssueClosed(target) : false))
}

/** ready = open, not deferred, not blocked — the steward/board work-queue predicate. */
export function isIssueReady(state: {
  closed: boolean
  deferred: boolean
  blocked: boolean
}): boolean {
  return !state.closed && !state.deferred && !state.blocked
}

/** The patch fields the close/reopen normalization touches. */
export interface ClosedPatchFields {
  stage?: string | null
  closedReason?: string | null
  supersededBy?: string | null
  duplicateOf?: string | null
}

/**
 * Make the closed predicate COHERENT under any update (#24). The tracker's
 * closed state is a derived predicate (stage === 'done' || closedReason != null),
 * which allowed three broken states. Normalization rules, applied to every patch
 * (all entry points converge on update()):
 *   - setting closedReason (non-null) moves stage to 'done' — closing IS done;
 *   - setting stage to a non-done stage on a closed issue is a REAL reopen:
 *     closedReason (and the supersededBy/duplicateOf close markers) clear;
 *   - a patch that sets BOTH a non-null closedReason and a non-done stage is
 *     nonsensical and rejected.
 * Deliberately permissive otherwise — coherence, not a workflow straitjacket.
 */
export function normalizeClosedPatch<P extends ClosedPatchFields>(
  row: IssueClosedFields,
  patch: P,
): P {
  const reopening = patch.stage != null && patch.stage !== 'done'
  if (patch.closedReason != null && reopening) {
    throw new Error(
      `cannot set closedReason '${patch.closedReason}' together with stage '${patch.stage}' — closing an issue moves it to 'done'`,
    )
  }
  if (patch.closedReason != null && patch.stage == null) {
    return { ...patch, stage: 'done' } as P
  }
  if (reopening && isIssueClosed(row) && patch.closedReason === undefined) {
    return { ...patch, closedReason: null, supersededBy: null, duplicateOf: null } as P
  }
  return patch
}
