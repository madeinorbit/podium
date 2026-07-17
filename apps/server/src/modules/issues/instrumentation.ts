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

/** Called by {@link IssueServiceCore.toWire} — the one increment site. */
export function countIssueWireBuild(): void {
  builds++
}

/** Issue-wire builds performed since the last {@link resetIssueWireBuildCount}. */
export function issueWireBuildCount(): number {
  return builds
}

/** Zero the counter. Tests call this to open a measurement window; production
 *  never does, so the counter is a free-running total there. */
export function resetIssueWireBuildCount(): void {
  builds = 0
}
