# oracle/ — owned by the parity oracle (POD-4443)

`expectedSnapshot(corpus, locals)` runs the LEGACY derivation
(`worklistSlice.derive` over a stub `Store` + stub `Replica` holding the
corpus rows) and projects the result onto the frozen `SliceSnapshot`:

- Row set: `unifiedWorkList` minus worktree-kind rows, flattened. Legacy nests
  formal children and started-by provenance children inside their parent's row;
  the slice is flat, so every nested descendant becomes its own top-level row
  and the flat list is re-sorted with the legacy `sortUnifiedWorkRows`
  comparator (band, sibling `sortKey`, creation order) — the order legacy
  would show if it rendered flat.
- `order.pinnedIds` from `splitPinnedWork` (fixture pins roots only, so the
  flat split matches the nested one); groups from `groupUnifiedWorkRows` over
  the flat remainder with the unselected baseline (`null, false`), with each
  group's snoozed lane merged back into `rowIds` in R-ORDER position (the
  snoozed disclosure is outside the slice's three components).
- Per-row fields read off the legacy row objects: `displayRef` (replica
  `displayRef`), `title` (`issueDisplayTitle` over all sessions, as the row
  renders it), `phase`/`working`/`asking` (`rowMotionPhase` /
  `rowHasWorkingSession` / `rowWaitingCount > 0` over the row's bubbled
  aggregate), `progressDone/Total` (the stamped `missionRollup`), `band`
  (`unifiedRowBand`), `repoKey` (`repoId ?? repoPath`), `closed`
  (`rowInClosedFold`, unselected baseline).

Selection (`locals.selectedIssueId`) does not affect the snapshot: the slice
publishes the unselected baseline and selection placement is the separate
`placeWorklistSelection` post-pass, which never re-derives rows.

Dropped at the projection boundary (in legacy, out of slice — all in G1's
out-of-scope list, spec §6): `startedByChildren` structure (flattened away),
`aggregateSessions` (folded into the per-row verdicts), `continuation`,
`missionRollup.fromChildren` detail beyond done/total, `activityAt`
(display-only R-BAND input), the `WORKING` partition, worktree-kind rows, and
the snoozed lane as a separate lane.

Bubbling rule (POD-4549): `phase`/`working`/`asking` roll up through the
VISIBLE formal subtree only (spec R-SUM amendment). `hidden-askers.ts` holds
the check over the fixture's hidden askers (`rootsAskingOverHiddenAskers`)
and the planted formal-subtree rule it must catch
(`plantFormalSubtreeBubbling`); `hidden-askers.test.ts` pins the isolated
cases.
