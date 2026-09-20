# fixture/ — owned by the deterministic corpus (POD-4443)

`buildCorpus(scale, seed)` mints the live-shaped corpus at 1x/2x/4x:
4,867 issues / 4,304 sessions / 500 repos / 468 worktrees at 1x, all four
multiplied by the scale. Seeded PRNG only — no `Math.random`, no `Date.now()`;
two builds with the same `(scale, seed)` are deep-equal.

The corpus carries BOTH spellings every consumer needs: the legacy rows the
parity oracle feeds to the real derivation (`issues`, `issueProjections`,
`sessions`, `repoProjections`, `issueDeps`, `repos`, `machines`, `pins`) and
the slice-shaped projection the row stream publishes (`sliceIssues`,
`sliceSessions`, `worktrees`).

Shape notes (see `docs/measurements/POD-4441-fixture-shape.md` for counts):
- Parent chains depth 1–4 with ~40% children; `discovered-from` edges on ~5%.
- ~2,230 open issues (no `closedAt`); sessions on ~60% of open issues, ~10%
  of sessions attached to a worktree path with no `issueId` (R3 ownership).
- The bulk is historical (decayed `exited` sessions, done/backlog issues) so
  the visible set stays at the live ~211 rows; agent-audience issues with
  live sessions exercise the legacy nesting drop.
- `FIXED_NOW` sits inside the defer band thresholds (past/future `deferUntil`
  both present) so bands 0/1/2 are all non-trivial.
- No `startedBySession`, no `resume` refs (legacy `dedupeSessionsByResume`
  would collapse shared refs), no `blocks` edges, no `supersededBy` /
  `duplicateOf` — the oracle drops or never reads those paths.
