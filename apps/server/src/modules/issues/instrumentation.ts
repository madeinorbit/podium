/**
 * Issue-wire build counter [POD-796] — the D7.2 bypass's evidence.
 *
 * ## What it counts, and why that unit
 *
 * One increment = one `IssueServiceCore.toWire(row)` — one issue's LEGACY
 * `IssueWire` payload built. That is the exact unit of the coupling POD-796
 * severs: `toWire` embeds `sessions: SessionMeta[]`, so it is the per-issue half
 * of the O(issues × sessions) build a session change used to force (ADR 4 D7.1;
 * p50 711ms ×2 per switch at 530-session scale, POD-701/POD-772 entry 1).
 *
 * Counting the per-issue build rather than the per-list call is deliberate: a
 * bypass that skipped the list but still built one issue would read as "1 call"
 * either way, while "0 vs 300 builds" states the complexity class the change is
 * actually claiming. The number IS the claim, so the test asserts on it.
 *
 * ## Why this counter is NOT sufficient on its own [POD-796, post-rebase]
 *
 * It reads 1, not 300, for a one-field session change on the post-POD-723 path —
 * and that number FLATTERS the old path into looking almost compliant. It is
 * not: POD-723's `toWireMemo` memoizes the expensive per-issue BODY, but it
 * still calls `sessionsForIssue(...)` for EVERY issue to compute the cache key,
 * and that is a filter over the whole session list. The O(issues × sessions)
 * scan D7.2 forbids survives the memo completely — 300 × 200 = 60 000 session
 * comparisons per session change — it just stops being visible to a counter
 * that increments inside `toWire`.
 *
 * This is exactly what ADR 4 D7.2 means by "Interim dirty-set shims
 * (POD-722/723) are scar tissue on the pipeline POD-308 deletes, NOT
 * compliance". D7.2's claim is about WORK PROPORTIONAL TO ENTITY COUNT, not
 * about serializations, so measuring serializations lets a shim that still scans
 * the world pass for compliant. Hence {@link issueMembershipScanCount} below,
 * which counts the thing the ADR actually forbids. Read them together: builds is
 * the cost per dirty issue, scans is the complexity class.
 *
 * ## Why a module-level counter
 *
 * The property under test is a NEGATIVE one that spans the whole composition —
 * "a session broadcast performs no issue work" is a statement about the wiring
 * between SessionsService, IssuePublisher and IssueService, so it can only be
 * observed at a seam all three share. Threading a counter dep through those
 * constructors would let a test satisfy the assertion by passing a stub that was
 * never wired to the real path — the one way this test could pass while the
 * bypass was broken. A module-level counter is read THROUGH the production
 * wiring (`new SessionRegistry(store)`) and cannot be faked.
 *
 * Safe as module state here in a way `@podium/*` module state is not (POD-746):
 * this module lives inside apps/server and is reached only by relative import,
 * so there is exactly one copy — no alias, no exports map, nothing to resolve
 * twice.
 *
 * DIAGNOSTIC ONLY. Nothing branches on this counter; it is never read by
 * production code, only incremented. A counter that changed behaviour would be
 * a second, invisible control path — see `IssuesRepository.quarantinedRowCount`
 * for the same posture on the store side.
 */

let builds = 0
let membershipScans = 0

/** Called by {@link IssueServiceCore.toWire} — the one increment site. */
export function countIssueWireBuild(): void {
  builds++
}

/** Issue-wire builds performed since the last {@link resetIssueWireBuildCount}. */
export function issueWireBuildCount(): number {
  return builds
}

/** Zero BOTH counters (builds AND membershipScans — the name predates the
 *  scan counter; every caller wants a full measurement window). Tests call
 *  this to open a window; production never does, so the counters are
 *  free-running totals there. */
export function resetIssueWireBuildCount(): void {
  builds = 0
  membershipScans = 0
}

/**
 * Called once per ISSUE TOUCHED by the list path — i.e. every issue whose member
 * sessions get scanned, whether or not a payload is then built.
 *
 * THIS is the D7.2 unit. "No code on the write, publish, or fan-out path may
 * perform work O(number of entities) per change" is a statement about work, and
 * each of these touches runs `sessionsForIssue()` — a filter across the entire
 * session list — so N touches is N × sessions of real comparison. A memo that
 * skips the rebuild but still computes the key still scans, and still costs
 * O(issues × sessions); only NOT REACHING THE LIST AT ALL is compliance.
 *
 * The increment sits at the per-issue seam in `list()` rather than at `list()`
 * itself for the same reason the build counter does: the claim is about the
 * complexity class, and a per-call counter cannot tell 1 issue from 300.
 */
export function countIssueMembershipScan(): void {
  membershipScans++
}

/** Per-issue membership scans since the last {@link resetIssueWireBuildCount}. */
export function issueMembershipScanCount(): number {
  return membershipScans
}
