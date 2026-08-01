/**
 * POD-797 regression counters. Builds count the session-free transitional
 * IssueWire residue. Membership scans count the deleted D7.2 coupling and must
 * remain zero for every session change; the production increment function stays
 * registered as residue so a reintroduced scan has an observable guard.
 */

let builds = 0
let membershipScans = 0

/** Called by {@link IssueStore.toWire} — the one increment site. */
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

/** Regression increment for any reintroduced issue membership scan.
 * There is intentionally no production caller after POD-797. */
export function countIssueMembershipScan(): void {
  membershipScans++
}

/** Per-issue membership scans since the last {@link resetIssueWireBuildCount}. */
export function issueMembershipScanCount(): number {
  return membershipScans
}
