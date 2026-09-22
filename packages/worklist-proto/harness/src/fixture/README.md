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
- Resume twins (POD-4551): one group per branch of `dedupeSessionsByResume`
  per scale unit (`resumeTwins`: all-inactive, tie, live), each on its own
  visible root. The oracle collapses them as the runtime does on every
  session read; the corpus tests prove a derivation that forgets the
  collapse fails parity on exactly the tie rows.
- Sort keys are minted by the model's `spreadSortKeys`, so every key passes
  `isSortKey` as a server-written one does (asserted at every scale).
- Hidden askers (POD-4551, the POD-4549 shape): 20 x scale asking sessions
  on archived/proposed children of visible roots (`edgedAskers`); legacy
  detaches the ask, so the roots do not ask.
- The shape holds at 2x and 4x (`corpus.test.ts`, "shape at %ix"): visible
  rows 211 x scale +/- 10%, depth shares within 5 points of 1x, ~10%
  prefix-owned sessions, ~5% discovered-from edges.
- No `startedBySession`, no `blocks` edges, no `supersededBy` /
  `duplicateOf` — the oracle drops or never reads those paths.
