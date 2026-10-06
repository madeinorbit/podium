# fixture/ — owned by the deterministic corpus (POD-4443)

`buildCorpus(scale, seed)` mints the live-shaped corpus at 1x/2x/4x: `scale`
copies of one workspace unit of 4,867 issues / 4,304 sessions / 9 kernel
repos / 17 repo roots / 468 worktrees (485 scan entries: the roots plus the
standalone entry a real scan reports for each linked worktree). Counts
multiply with the scale; shares and depths stay. Seeded PRNG only — no
`Math.random`, no `Date.now()`; two builds with the same `(scale, seed)` are
deep-equal.

The corpus carries BOTH spellings every consumer needs: the legacy rows the
parity oracle feeds to the real derivation (`issues`, `issueProjections`,
`sessions`, `repoProjections`, `issueDeps`, `repos`, `machines`, `pins`) and
the slice-shaped projection the row stream publishes (`sliceIssues`,
`sliceSessions`, `worktrees`).

Shape (POD-4635; counts in `docs/measurements/POD-4441-fixture-shape.md`):
the unit plan is the live export's per-kind table (POD-4552, 2026-09-23)
scaled to 4,867 issues. Only the export's SHAPE is used, never its content.
`corpus.test.ts` holds every dimension of the live table within 20% at every
scale, measured by the same `measureShape` the live comparison uses.
- ~732 visible rows at 1x: ~271 top-level (review / in-progress / planning
  roots, closed top-level rows in the fold, a rescue parent per keeper
  pair) and ~461 nested ones. Nesting is mostly formal: 30 mission roots
  carry deep agent subtrees; 12 top-level issues nest by `startedBySession`.
- 61% of issues have a parent; depth 3+ is 28%; max depth 6.
- Edges: `discovered-from` on 34% of issues (mostly proposed spin-offs),
  `blocks` ~33%, plus `related`, `supersedes`, `duplicate`, `blocked-by`,
  `waits-on`, `duplicates` and one unknown type. A visible row is never
  blocked by open work and no visible review row is a spin-off origin:
  both change what a row asks, and spec §6 keeps dependency semantics and
  the continuation walk out of the comparison.
- `startedBySession` on 73%, `coordinatorSessionId` on 26%, resume refs
  on 76% of sessions (unique outside the planted twin groups).
- Lanes: 17 roots per unit, 202 worktrees nested inside a root, 19
  fork-trap pairs (`/w/alpha` vs `/w/alpha-fork` among them); 15% of
  sessions carry no issue, 11% sit in no lane at all.
- Ids follow creation order (a child after its parent), as live `seq` does.
- One moment's measures are chosen, not copied: about 2% of sessions are
  live and 5-8% of rows working (live at 06:38Z: 0.7% and 1.2%), so #2 and
  the working roll-up have work to move. The phase shares match live.
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
- The unscanned worktree (POD-4550) and the rescue/keeper pair (#6d) are
  planted as before.
- The #2 target (`pickTargets`) has a family larger than one level of the
  reads budget (`PHASE_FAMILY_FLOOR`), so a sibling re-read fails #2.

Two axes (POD-4747): `buildCorpusCell({ history, active })` grows history
(closed, archived and deleted work and its sessions) and active work (open
issues, live sessions, visible rows, lanes) separately. A cell is the 1x unit
(byte-identical to `buildCorpus(1)`), then `active - 1` active units (the
plan's active roles, with their lanes and sessions) and `history - 1` history
epochs (the history roles only, no lanes, no live session, each epoch's clock
120 days further back). Every added unit has its own seeded stream and links
only inside itself. The growth cells: `h1a1` 4,867 issues; `h10a1` 27,601
issues / 30,611 sessions, every active row and the visible list as at `h1a1`;
`h1a4` 11,890 issues, exactly 4x the active issues, sessions, lanes and
visible rows (2,928), every history row as at `h1a1`. `cells.test.ts` reads
each row's axis from the rows and the oracle (`splitAxes`), proves those
invariants row for row, and holds each axis's shape within 20% of the base.
