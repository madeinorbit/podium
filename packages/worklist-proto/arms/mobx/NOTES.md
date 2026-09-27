# arms/mobx — notes

## Mc4 MobX growth and coexistence (POD-4576) · 2026-09-27

Baseline: the LAZY arm (POD-4705 landed: bootstrap 669.9 ms / 3.52x, heap
60.75 MB / 2.69x, switch 570.5 ms / 2.60x; per-change counts byte-identical
to eager). Addenda 1–3 stand on the lazy arm: heap per scale + by-constructor
at 4x vs eager 85/161/311 MB; stage-move attribution (list.tsx items rebuild
vs virtualizer getMeasurements vs GC) with a 4x CPU profile, fix in the idiom
if one dominates; ill-conditioned slope flag (1x excess < 1 ms) with the
budget NOT re-read; coexistence via the count harness.

Plan: (1) growth counts first (`worklist/growth.test.tsx`: #1–#5 at 1x/2x/4x
through `runFenceStep`, flat reads/commits/derivations). (2) browser growth
matrix on flatblock (`~/podium-timing-4576`, lease `bench:flatblock`, MobX
first, interleaved with control+noop, heap per scale from the same run).
(3) coexistence (`worklist/coexist.test.tsx`: solo vs co-mounted heartbeat +
click). Timing machine queue: POD-4707 holds `bench:flatblock`; queue with
`--wait`, never touch flatblock's global bun.

## Round three: incremental grouping and the read-state lane (POD-4686) · 2026-09-25

Code: `pool/worklist/groups.ts` (maintained buckets, per-group head rank,
unlatched base lanes), `pool/worklist/visible.ts` (read-state lane input,
placement filing reaction), `pool/pool.ts` (read-state lane, volatile
ingest), `pool/tables.ts` + `pool/residency.ts` (volatile hooks),
`pool/rebuild.ts` (lane input from the row), `pool/worklist/scaling.test.ts`
(the counts).

### Decisions

- **The layout is maintained, not re-enumerated.** One reaction per node
  (`pool.layout.<id>`) files its placement into buckets when it changes; a
  stage move files one id between two lanes. Lanes sort per group at view
  time; group keys sort each bucket's head rank. The old whole-order
  `layoutOf` stays as the pure function the rebuild and the plants use.
  First cut derived keys from the order and re-walked it per move (732 /
  2,928 ids, invisible to the filing counters — coordinator verification);
  keys now read only bucket membership and head ranks, and `order` stays
  alive through a bare subscribed read so its sort counter stays honest.
- **The read cursor lives beside its row.** `issue.readAt` is kept in a
  per-key-tracked lane; a cursor-only update skips the slot write (no
  relation, residency or cold-rule input reads it — checked against the
  schema), so a click re-validates only the clicked row. `unread` and a
  decay row's `flat` derive the same cursor from the lane.
- **Counts, not walls, carry the verdict** (`scaling.test.ts`, direct pool,
  1x and 4x): stage move = 1 filing + its lanes + ≤4 set writes + 0
  key-index reads + 0 order walks, keys/pinned/latch execs bounded, moved
  lanes exactly once; click = 0 maintenance reactions, latch once, lanes
  once each doing O(1) latch checks, rest silent; archive = 1 flip + 1
  re-sort + 1 un-filing with 0 order walks. The order walk is counted
  through a proxy on the host seam, so walks through plain maps count too.
  A walk hidden in the key body only executes when the body genuinely
  re-runs (membership change, as in archive) — on lane moves MobX
  short-circuits it, so the walk test lives on archive, with the
  coordinator's verbatim order-walking mutation as its red plant (731 /
  2,927 walked reads vs 0). Whole-list plants (layoutOf touches;
  re-file-all set writes; slot replacement ≥3 reactions) fail each bound.
  Re-time (`results/4686-quiet`, 36 ok, load ≤ 8): 1x walls near Mb4, 4x
  slopes still over on a heap story the untouched paths share (pool page
  311 MB at 4x) — follow-up (Mc4), not pool-chasing.

### Observations (not fixed here)

- **Latch staleness on selection.** Tracing a click showed every lane
  scheduled exactly once with O(1) bodies, which is the bound the test
  pins — but a direct always-fire observer on `latchedOpenId` never fired
  across two selection changes in a scratch probe, while the same closure
  observed directly does. Unresolved whether MobX defers that reaction's
  baseline past the change or the computed genuinely never propagates;
  invisible to every gate (tests read fresh; the latch lane only matters
  for a selected grace-folded row). Left for the latch's owner with this
  pointer, not chased: it changes no count in this issue.
- **Test hygiene that burned an hour.** A `ReferenceError: audit is not
  defined` from a `finally` masked the real error twice over: (1) declare
  audit handles OUTSIDE `try` so `finally` can never mask; (2) cross-check
  `git status`/hashes before blaming logic — rapid `fetch` + `reset
  --hard` + rerun cycles on one checkout can execute mixed code across
  resets (symptom: impossible errors in self-consistent files). Slow down
  the cycle or clear transform caches between resets.

## Round three: whole-row gate and `activityAt` (POD-4674, POD-4679) · 2026-09-24

Code: `pool/gate.test.ts` (whole-view check, observer, three view plants),
`pool/rebuild.ts` (`rebuildViews`), `shared/src/gen/check.ts` (`diffViews`,
the comparison both pool gates call), `pool/views.ts` (`activityAtPartOf`,
`ViewInputs.retainedSeats`, the view's max with `seatActivity`),
`pool/worklist/visible.ts` (`retainedSeatIds`), `pool/worklist/rollup.ts`
(`seatActivity`, Mb3's composition).

### Decisions

- **The gate compares whole views** (H3-F3). The checker compares
  `snapshot()`, whose rows are `sliceRowOf(view)`: 11 fields. Every compared
  step now also holds every visible issue's whole `RowView` to
  `rebuildViews` (the same rule table over the feed's rows), field by field,
  with the shared `diffViews`. The hand gate calls the same function.
- **The gated arm is OBSERVED** as a mounted list observes it (one reaction
  over every visible row's view and the layout; Mb3's lesson from the
  roll-up gate). Unobserved, every computed re-runs on each read and a stale
  cache cannot show.
- **Three view plants**, H3's in MobX terms, each must fail every seed:
  `activityCached` (member activity in a plain `Map`; the view check must
  be what catches it), `presenceUntracked` (presence asked of the table
  untracked), `chainUntracked` (another issue's parts, the origin's that
  `originTick` reads, read untracked).
- **`activityAt` is the legacy's** (POD-4679, coordinator: POD-4674 owns it
  in both pools). Own half: the retained seats' stamps (`retainedSeatIds`,
  legacy `retainedSessions`: seat members retained at the clock, exited ones
  included), else `updatedAt`, else 0, with the legacy's `||` (a zero stamp
  falls back), `rows.ts:98-116`. It read every explicit session before
  (archived, shell and decayed ones included). Subtree half: raised by the
  latest roster seat nested below (`rows.ts:336-339`), Mb3's `seatActivity`
  composition (6702973af, taken out for this issue and restored here).
  `retained` and `rosterIds` now derive from `retainedSeatIds` (Mb3's
  b28ee7b85 shape).
- **Tests that encoded the old rule, changed to the oracle's:**
  - `residency.test.tsx` "models == rows the mounted list drew": session
    models are the drawn rows' resident RETAINED SEATS, not every explicit
    member.
  - `residency.test.tsx` "loads every row asked for inside one 50 ms
    window": the watched row's view now decides its retained seats, which
    reads each cold member's retention by id (a per-row feed read, never a
    load; asserted to stay cold) beside Mb3's cold-children reads.
  - `residency.test.tsx` "a row reads its cold sessions as loading": the
    loaded closed issue has no retained seat (finished runs past their keep),
    so its `activityAt` is its `updatedAt`, not its sessions' latest.
  - `counts.test.tsx` "a sibling re-read alone fails #2": the family the
    plant re-reads is the row's retained seats (5), not every session naming
    the issue (7).
  - `worklist/visible.test.tsx` "a list that draws hidden rows fails the
    commit fence on #4 (a hidden spin-off)": #1 no longer catches it; the
    heartbeat session is a retained seat of no hidden row.
  - `worklist/rollup.test.tsx` parity: the commit fence's `activityAt`-alone
    allowance (`assertCommitsBesideActivity`) is gone; plain `assertCommits`.
  - `pool/gate.test.ts` "row fields against the oracle": `activityAt` is
    asserted on every visible row (it was measured, not asserted).
  - The same test's POD-4671 row (`i3485`, the unscanned-worktree orphan
    with no R3 seat) leaves `activityAt` out with its other seat-fed fields:
    the orphan's stamp is exactly the one the pool misses.
- **Controls** (mutants on the committed code, restored with `cp`): the own
  half's loop put back to every explicit session fails the row-fields test
  at `i4603.activityAt` (pool later than the oracle: the row POD-4679
  reported); the view's subtree raise removed fails it at `i3973.activityAt`
  (pool earlier). The real code passes it on every other visible row.

### Gate of record (L4b, 1x), 2026-09-24: GREEN

Seeds 1-5 x 300, `gate.test.ts` "correctness gate", one seed per run through
the package config (`POD_POOL_GATE_FIRST_SEED`), 12:59-14:40 at load 10-20
(pass/fail and counts only, no walls). Seeds 1, 2, 3 and 5 ran on this
branch rebased on integrate/4545-round-three at ccb9ef483 (Mb4 landed); seed
4 on the tip rebased on 7909a416c, which changes only a comment in this
gate and the POD-4671 test allowance (no pool code). Every compared step:
the rebuild, every relation against the scan, the partition, the oracle
every 10 steps (Mb4) and every visible issue's whole `RowView` against
`rebuildViews`. Two earlier runs of seeds 1 and 3 were killed by the
sessions slice's OOM killer (17 GB shared by every session; this run's own
scope held about 1.9 GB) and were re-run. All seven plants failed every
seed ("check, step"):

| seed | views compared | oracle checks | removal-deaf | cold-deaf | cold relink | promote skipped | activity cached | presence untracked | chain untracked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 190328 | 31 | rebuild 5 | partition 6 | relations 24 | checkpoint | views 13 | views, boot | views 13 |
| 2 | 201974 | 31 | rebuild 41 | relations 20 | relations 20 | checkpoint | views 18 | views, boot | views 0 |
| 3 | 222611 | 31 | rebuild 19 | relations 3 | relations 3 | checkpoint | views 37 | views, boot | views 14 |
| 4 | 195594 | 31 | rebuild 26 | relations 37 | relations 96 | checkpoint | views 35 | views, boot | views 17 |
| 5 | 213705 | 31 | rebuild 1 | relations 7 | relations 7 | checkpoint | views 0 | views, boot | views 1 |

The first 5 x 300 attempt (before the plant rework) had `activityCached`
PASS on seed 1: it cached only the model path, and since the subtree half
the view is the max of both halves, so the worklist path carried every live
seat's stamp past the cache. The plant now caches both paths. Its
`chainUntracked` also passed: cutting only `originTick`'s read of the
origin's parts rarely fires; it now also cuts the children's roll-up
results. A first broader cut (every node read untracked) made MobX warn that
`tip` read no observable, a crash rather than a catch.

## Round three: structural scenarios and the browser, b4 (POD-4572) · 2026-09-24

Code: `harness/src/roster.ts` (the pool on the roster, `RosterAllowances`),
`harness/src/fences.test.tsx` (the roster loop with named allowances),
`pool/worklist/known-gaps.ts` (`MOBX_POOL_ALLOWANCES`), `harness/web/entries/mobx.ts`
(the page mounts the round-three pool), `harness/web/entrylib.ts`
(`parityAllowance`), `harness/browser/run.ts` (console trap, `--console-plant`),
`pool/mobx-trap.ts` (`errors`), `pool/views.ts` (`firstMemberOf`),
`pool/enumerate.ts` (`knownTables` from the feed). Tests:
`harness/src/fences.test.tsx`, `harness/native/mobx-pool.native.test.tsx`,
`pool/worklist/draft-title.test.tsx`. Numbers: `docs/measurements/POD-4572-b.md`.

### Mechanism fixes (and whether each added a place to remember)

- **None needed on the count fences.** Run first, before any change: every
  step #1-#10 commits exactly the oracle's changed rows and reads within its
  budget, beside Mb3's three named exceptions. The typical misses the brief
  names were already absent: #8 (a 60 s tick) reads 0 rows and commits 0, #8b
  (the grace crossing) reads and commits exactly its 6 crossers (the clock is
  deadlines, `pool/clock.ts`); #5 (stage move) commits 1 row and runs the
  layout once. No place to remember was added.
- **A draft's title skipped nothing** (`views.ts` `firstMemberOf`). The legacy
  names a draft after `sessionsForIssueNav(...)[0]`, which leaves out shells,
  archived and headless sessions; the pool took its first member of any kind.
  Invisible at 1x and 2x; the 4x browser parity caught it (`i10142`, `i13682`
  "New Shell session" against "New Codex session", `i3081` against "New
  Claude session"). `draft-title.test.tsx` holds every visible 4x draft to the
  oracle and requires a shell-first draft to exist; A/B on flatblock: the old
  rule fails it (`i13682`), the fix passes. PLACE TO REMEMBER: none new (the
  rule lives in the one function the model and the rebuild share). The hand
  pool has the same rule (`arms/hand/pool/views.ts`); its lane was mailed.
- **The page's rescope stages the grown scope's scans** (coordinator ruling
  on this issue's finding; `harness/src/rescope.ts`). It staged the 2x rows
  but not the 2x scans, leaving seven 2x issue worktrees unscanned at the
  grown state (POD-4671's class: `i4944`, the 2x orphan, and `i5950`,
  `i6651`, `i6875`, `i7502`, `i8964`, `i9549`; `s5122` under
  `/repo-000/.worktrees/w00477/sub` linked to the repo-root lane). The first
  landing widened the POD-4671 allowance to the class; the ruling reverted
  that (a harness artefact must not become a permanent exception). Now the
  allowance is the corpus's ONE orphan again, the caller passing the corpus
  whose rows are installed; `harness/src/rescope.test.ts` shows only `i4944`
  unscanned at the grown state (262 with the old rows-only staging). PLACE
  TO REMEMBER: none.
- **`knownTables` reads lanes and repos from the feed** (`enumerate.ts`),
  the switch its comment assigned to Mb4: the relation check no longer
  leans on the pool's own tables for the never-cold entities.

### Decisions

- **Named allowances live on the roster entry** (`RosterAllowances`: parity,
  undrawn, reads), each naming the issue that removes it, applied only by
  `fences.test.tsx`, recorded per step in the results cell (`allowed`), and
  FAILING the suite when no step needed one (a fixed gap takes its allowance
  with it). The pool carries Mb3's three: POD-4671 (parity), POD-4674
  (`activityAt` alone on #10's `i937`), POD-4678 (#10's re-listed family,
  92 reads). The roster's pending exception for `mobx` is gone.
- **The page's parity takes the same POD-4671 allowance**
  (`MountPageOptions.parityAllowance`); each record's `parity.allowance`
  names the rows when it applied.
- **The console trap.** The pages are production builds, where MobX's
  enforcement warnings are compiled out (`__MOBX_DEV__` is
  `NODE_ENV !== 'production'`); a throw inside a reaction is still reported
  through `console.error`. `run.ts` fails a candidate arm's run on ANY
  console warning or error (other pages' are printed). Proven armed:
  `--console-plant warn` and `--console-plant reaction` each fail a run
  (`[plant] console warning`; `[mobx] uncaught error in 'Reaction[Reaction]'
  Error: [plant] thrown inside a reaction`). The native lane runs under
  `installMobxWarnTrap({ errors: true })` with a planted warning and a
  planted reaction error; its first catch was real: React's "suspended
  resource finished loading outside act" from the lazily imported native
  list, fixed by awaiting that module inside an act.

### Numbers (flatblock; `docs/measurements/POD-4572-b.md`)

- Counts #1-#10 at 1x: every step exact against the oracle, within its reads
  budget, parity green, with Mb3's three named allowances (the table is §1).
- Pool gate with the oracle at its default and the roll-up gate: green, 3 x 200,
  every plant caught on every seed (§2).
- Hot path at 1x (n = 20, load ≤ 8): within budget on click (13.7 / 23.8 ms
  p50/p95), clock (0.5 / 0.6), rename (7.1 / 10.0), visible heartbeat (18.1 /
  23.6); over on stage move (11.2 / 24.4 against 20.1) and the unrelated
  heartbeat (21.7 against 21.5). The control: 130-135 ms p50, 276 row commits,
  one long task per change. Excess slope over 1.2 on every scenario but the
  clock; diagnosis and follow-up in POD-4686.
- Lifecycle at 1x: cold bootstrap 775.7 ms against the control's 214.5 (budget
  236.0), retained heap 81.1 MB against 22.6, principal switch 639.8 against
  254.0 (budget 508.0): the a-phase pool's construction cost, recorded.

### Open

- POD-4686: stage move's whole-order layout and the click's visibility
  re-validation grow with the visible set.
- The bootstrap and switch walls (3-4x the control's): the pool's construction
  (IssueNode per known issue with three reactions, 2,736 resident issues and
  2,548 sessions at 1x). Not a b-phase mechanism; left for the decision.
- A draft's "first" member: the legacy orders by the engine's session array
  (arrival), the pool by id. They agree on every scale here once shells are
  skipped; on data whose ids do not sort in arrival order they could differ.

## Round three: lazy per-row roll-ups, b3 (POD-4571) · 2026-09-24

Code: `pool/worklist/rollup.ts` (the combines, the per-session rules, the
node parts), wired on Mb1's nodes (`pool/worklist/visible.ts`), the row view
(`pool/views.ts` `buildRowView`) and the fold placement (`groups.ts`
`withWaiting`). Tests: `pool/worklist/rollup.types.test.ts` (compile-time
capability, combine laws), `pool/worklist/rollup.test.tsx` (parity on every
fence scenario, L1d askers, the depth-4 chain fence and its plant, cold
children). The brief's path `arms/mobx/worklist/rollup.ts` is the frozen
round-two layout; the round-three pool lives under `pool/`.

### Decisions

- **The combines have no store.** `aggregate({ own, children })` and
  `unitsOf({ children })` take plain data and return plain data; the type test
  holds their exact parameter types and that everything through them is plain
  data, with `@ts-expect-error` negatives (a store beside the inputs, a store
  as a child, a function inside an aggregate).
- **The root reaches the aggregate without a walk.** `motionPhase(s, row)`
  depends only on whether the ROW is finished (an offer-only ask is not
  waiting under a finished row). Every aggregate carries both verdicts
  (`open`, `finished` flags), so it is a function of (own, children) alone;
  the row picks at the end (`rollupOf`). Round two's hand early-stop failed
  on exactly this (offer removal on a finished child).
- **Two trees, as the legacy has two.** Attention (`phase`, `working`,
  `asking`) composes over the NEST children, the inverse of Mb1's
  `nestParent` (formal nearest-present ancestor, walked past hidden issues,
  or the started-by owner: `rows.ts:331-334`), maintained per node by a
  reaction into `VisibleCollection.nestedBy` (keyed by id, so it outlives a
  replaced parent node). The declared `issue.children` cannot serve here: it
  drops an archived child's edge, and the legacy nests a visible grandchild
  under an archived child up to the root. Progress composes over the
  declared `issue.children` (the formal closure `missionRollup` counts, the
  archived branch cut by the relation's `where`).
- **A row's own part** reads its own row and Mb1's roster (retained, not
  exited, no shell, not archived), each seat's cached verdict
  (`SessionNode.verdict`) and its own pending decision, withdrawn by a working
  seat or a continuation (superseded / duplicate, or a started or staffed live
  spin-off: `tip`, a composition over the declared `spinOffs`).
- **Cold rows, two ways** (coordinator ruling 2026-09-24, option A, on the
  evidence below). PROGRESS never loads: a cold formal child gives its
  R-ROLL facts (`ProgressFacts` = `stage`, `closedReason`, by type) through
  the cold-read path (`coldRow`: counted, fenced, tracked by residency's
  per-id atom), `vacated` from the `spinOffs` size and Mb1's cached session
  presence. ATTENTION keeps Ma3's pending marker: a cold seat or a cold
  spin-off is read only as resident (`MobxPool.loaded`: the row, or
  `LOADING` with its load queued), a cold row is only its marker until it
  lands, and the view shows `loading` meanwhile. Under `unlessShown` that
  path has cases only on continuation spin-offs (and transient cold rows).
  WHY NOT LOAD FOR PROGRESS (the first version did): 73 of 732 rows showed a
  progress marker at first paint and the first read queued 282 closed
  issues; and every load relinks its row, which hid the pool gate's
  `coldRelinkSkipped` plant on two of three seeds (A/B on the same seeds:
  base 98430f2df caught it 3/3 at steps 24, 20, 3; loading 1/3 at step 88).
- **`closed` / `dismissed`**: the own part and the placement compute the fold
  verdict with nothing waiting assumed; the view and `IssueNode.placement`
  apply the roll-up's `asking` (`waiting`), and the placement reads it only
  for a row the fold would take.
- **Counting**: `ArmStats.rollupsDerived` counts runs of the two
  compositions (a node's `aggregate` and `unitsBelow`), through the shared
  stats.
- **Filings, not re-listings.** The fence counts every id a `many()` yields,
  so re-listing a bucket on a membership change reads the whole family. Both
  compositions read a FILING maintained by one reaction per node:
  `nestedBy` (by `nestParent`) and `childrenBy` (by the declared
  `issue.parent` key, computed with the engine's own `relationRef` over the
  node's row, so a parent's load does not re-run its cold children's
  filings, which `one()` would: it reads the target's presence). #7 re-parent:
  1 read against 21 (re-listing read 32).
- **`activityAt` is NOT here** (coordinator, 2026-09-24: POD-4674 owns it in
  both pools, with POD-4679). The legacy raises it by the nested seats
  (`rows.ts:336-339`, `attach`), so it is a subtree roll-up too; a
  `seatActivity` composition doing that was written here (6702973af) and
  taken out again for POD-4674 to reuse. `rollup.test` allows exactly the
  rows whose oracle view moved in `activityAt` alone to stay undrawn.
- **Mb1 fix in passing:** `memberIds` = explicit members + `laneMemberIds`
  (R3 alone, its own part), so a new explicit member no longer re-lists its
  worktree's sessions (#10: 26 worktree reads gone).

### Filed while here

- **POD-4671** — sessions under an issue worktree that no scan reported get no
  R3 seat: the shared schema's prefix relation resolves against scanned lanes
  only; the legacy adds every issue's `worktreePath` as a containment root.
  The fixture's `unscannedWorktree` (`i3485`, `s804`) is the one row off
  (phase/working). ONE named exception, `worklist/known-gaps.ts`, used by every
  oracle comparison; it throws once the seat exists.
- **POD-4678** — #10 burst50 reads within budget at 1x and 4x (fixed):
  a new explicit session costs the new member, not the family. `seatIds`
  (`visible.ts`) and `sessionIds` (`views.ts`, the row view's draft-title and
  loading inputs — same family shape, found while proving #10 red) read a
  maintained `pool.seats` mirror (one element per `issue.sessions` bucket
  move, in the same action that moved the bucket), never the bucket re-listed
  through the fenced `many()` (which counts every id it yields). Declared
  once in the schema (`issue.sessions`); the mirror follows the engine's
  delta via `PoolRelations.onBucket` (`relations.ts`, generic, no relation
  named) in `MobxPool` (`pool.ts`, closure-held so the copy sweep never walks
  it: ids only, never rows — closures stay a review item). No per-session
  reactions; no second index in the view. `rollup.test` holds #10 to its
  budget with no family term; the re-list plant (`seatRelist`, pre-fix
  `seats` via fenced `many()`) fails #10 at both scales while parity stays
  green (named `burst seats are O(1)`). Roster allowance deleted
  (`known-gaps.ts`).
  - Bootstrap (counts, `bootstrap.test.ts`, spy adds, no models): 1x lazy
    210722 → 216503 observables (+5781, +2.7%; `pool.seats` 2133 sets,
    `pool.seats.bucket` 3648 elements); allResident 225969 → 231750 (+5781);
    4x lazy 843739 → 866881 (+23142, +2.7%); allResident 903550 → 926692
    (+23142). `IssueNode` 155744, `SessionNode` 13710, `pool.visible.nodes`
    4867 unchanged at 1x (no new nodes/reactions — option (a)'s cost, one node
    + reaction per known session at bootstrap, avoided). Linear in scale
    (4x ≈ 4× 1x for seats/elements). Time: test Durations 151s → 142s total
    (load uncontrolled, no regression; walls with bench lock not run).
  - Transfers to the hand arm (POD-4683, same family shape in `seatIds` /
    `memberIds` / `childIds` copying + sorting E's bucket on every membership
    edge, and `views.sessionIds`): maintain the member set from the relation's
    own delta (one element per move, filter applied to the delta only; an
    existing member's filter-input change carries its own update), in the
    pool's relation-maintenance path or schema, never as a second hand-written
    index in the view, no per-entity listeners. The hand idiom's equivalent is
    a cell maintained from the bucket delta (not a re-list), read without
    counting family; rebuild from scratch stays the oracle.

### Numbers (1x, `FIXED_NOW`, counts; `harness/browser/results/mobx-rollups-*.json`)

Every fence scenario, one engine, mounted (`rollup.test.tsx`): snapshot =
oracle (POD-4671's row excepted) = rebuild after bootstrap and every step;
commits exact against the oracle's row views (roll-ups included).

| step | oracle changed | committed | reads / budget | compositions |
|---|---|---|---|---|
| #1 heartbeat | 0 | 0 | 2 / 3 | 0 |
| #2 phase | 1 | 1 | 1 / 3 | 1 |
| #3 click | 1 | 1 | 1 / 3 | 0 |
| #4 rename | 1 | 1 | 1 / 3 | 0 |
| #5 stage move | 1 | 1 | 1 / 24 | 1 |
| #6a new issue | 0 | 0 | 5 / 16 | 2 |
| #6b archive | 0 | 0 | 1 / 15 | 1 |
| #6c evict | 0 | 0 | 1 / 15 | 0 |
| #6d evict keeper | 0 | 0 | 2 / 30 | 2 |
| #7 reparent | 2 | 2 | 1 / 21 | 4 |
| #8 tick | 0 | 0 | 0 / 0 | 0 |
| #8b grace tick | 6 | 6 | 6 / 144 | 0 |
| #9a/b/c mark-read | 0 | 0 | 1 / 3 | 0 |
| #10 burst | 48 | 47 (+ `i937`, activityAt alone: POD-4674) | 101 / 168 (POD-4678, was 192 / 168 + 92) | 37 |

Chain fence (depth 4, `i2770 < i2763 < i2720 < i2666 < i2577`, a question on
`s340`): 1 row read (the session) against 15; **5 compositions = depth + 1**.
Planted `everyAggregate` (every aggregate reads an epoch each feed event
bumps): 737 compositions, reads 1, commits and parity still exact: only the
count sees it. At 1x both depth-4 missions already wait under an open root,
so the test flips the finished-root flag (a question waits under both).

First paint, counted from outside the pool (`rollup.test.tsx`, mounted,
before any load lands; declared rule `unlessShown`):

| | 1x | 4x |
|---|---|---|
| visible rows (cold) | 732 (0) | 2,928 (0) |
| rows `loading` / from a roll-up marker | 87 / 0 | 318 / 0 |
| loads queued (all Ma1's own: seats, origins) / windows | 84 / 1 | 315 / 1 |
| cold formal children of visible rows / progress loads | 247 / **0** | 923 / **0** |
| progress's cold reads (rows, each once) | 365 | 1,339 |
| per-row feed reads at first paint (all paths) | 3,630 | 13,953 |

Cold progress, both ways: `i3150` (hot, visible) with cold done child
`i3195`; its first view matches the oracle (9/10) with the child never asked
to load; the child closed as cancelled while cold moves the parent to 8/9 =
oracle (2 feed reads in the step). The same pool with the facts kept in a
plain map (tracking removed) stays at 9/10. (`untracked` alone could not
plant it: the cold row's update also notifies its residency atom, which the
part's `spinOffs` size read tracks.)

Attention pending: `i4768` (no session on the task, cold started spin-off
`i301`) reopened to review: its view shows `loading`, `asking`, `waiting`
while `i301` is queued; one window later the continuation withdraws the ask
(`asking` false, `queued` = oracle).

L4b with the oracle EVERY step (`worklist/rollup.gate.test.ts`, 3 seeds x
200, arms observed as a mounted list observes them): green against the
oracle and the rebuild; POD-4671's row taken from the oracle 402 times per
seed (twice a step, the same row). The untracked-nest plant fails every seed
(steps 46, 40, 106: a stale `working` / `phase` / `asking` against the
rebuild). Unobserved, the same plant passed all three: every computed
re-ran per snapshot, so no stale cache could show.

Pool gate (`pool/gate.test.ts`, rebuild-only, 3 x 200, its four plants),
condition 2's A/B on the same seeds: base 98430f2df (A) and 2b42d453b
(option A, B) both catch `coldRelinkSkipped` on 3/3 seeds at steps 24, 20
and 3, and every other plant 3/3; the correct arm passes every seed. (The
first version, which loaded cold children for progress, caught it 1/3, at
step 88.) Its timeout is now 5 s per seed-step: with the roll-ups every
unobserved snapshot and rebuild derives them (26.5 min at load ~9).

L1d askers: every visible root over a `corpus.edgedAskers` hidden child reads
the oracle's `asking` and `phase`.


## Round three: groups, closed folds and the windowed list, b2 (POD-4570) · 2026-09-24

Code: `pool/worklist/groups.ts`, `pool/react/list.tsx`, `pool/native/list.tsx`.
Tests: `pool/worklist/groups.test.tsx` (parity #1-#7, fences, latch, window),
`harness/native/mobx-pool.native.test.tsx` (native window). The brief's paths
`arms/mobx/worklist/groups.ts` and `arms/mobx/react/list.tsx` are the frozen
round-two arm's layout; the round-three pool lives under `pool/`.

### Decisions

- **A row's placement is a part on its node** (`IssueNode.placement`,
  `computedStruct`): pinned, `repoKey`, label (path tail), fold verdict
  (views.ts `closedOf`, the same one the row's `closed` field uses),
  `dismissed`, fold stamp. Read from the own row hot OR cold, so a closed
  visible row is placed without loading it. A rename, phase change or
  heartbeat leaves it equal and stops there.
- **One layout computed** over `worklist.order` and the visible placements:
  it re-runs only when either moves (`counters.groupRuns`,
  `.groupElements`), at the visible count. It is the snapshot's `SliceOrder`
  (no selection, spec §7).
- **One `GroupNode` per key** with `rowIds` / `closedIds` as
  `compareShallow` computeds over the layout, the R-GROUP 5 latch applied:
  a layout run that leaves a group's lanes equal keeps their identity, so its
  header does not redraw. The latch is one computed (`latchedOpenId`) that
  reads the selection and that one row's placement; the pool now carries
  `selectedIssueWasFolded` (`foldLatch`), which it ignored before.
- **The rebuild groups with L1b's `groupKeyOf` / `compareClosedFold`** over
  its own views, not with `layoutOf`: the gate holds the live placement and
  layout to the contract's grouping.
- **Windowing**: web `@tanstack/react-virtual` 3.14.13 (new dependency,
  pinned), 56 px rows and 40 px headers (the browser driver's viewport is
  sized to them), overscan 5; native `SectionList` (initial 24 rows). The web
  list measures its container before paint; with no height (happy-dom, the
  count lane) it draws every item, as round two did, because the commit fence
  there asks for every changed visible row. The browser entry still mounts the
  round-two arm; switching it is Mb4.
- **Closed folds start open**; a header toggles its fold (UI state in the
  list, never data). Folding one moves the rows out of the window's items.

### The waiting stub, named (Mb3)

The fold verdict's "nothing waiting in the subtree" conjunct reads Mb3's
roll-up (`STUB_WAITING`, like the row's own `closed`). At 1x three settled
closed roots fold here and stay open in the oracle: `i103`, `i2377`, `i4446`
(each `asking`, phase `waiting` in the oracle's views). The parity check
derives that set from the ORACLE and requires the difference to be exactly
those rows moved into their fold; the check fails once Mb3 wires waiting in
(tripwire), and must then become exact parity. The same stub hits the
commit fence on #7: the reparent changes the old and new parents'
(`i214`, `i591`) progress only, a roll-up; a row missing from the redraw is
accepted only when the oracle's own before/after views differ in
`STUB_ROLLUPS` fields alone, and an extra redraw never is. **Mb3 must also
make `placementOf` read the waiting roll-up**, or the lanes stay wrong while
the row's `closed` is right.

### Numbers (1x, `FIXED_NOW`; `harness/browser/results/mobx-groups-*.json`, gitignored)

Parity (`groups.test.tsx`), after bootstrap and after each of #1-#7: the
grouped order equals the oracle's `SliceOrder` with the stub's three rows
folded (21 pinned, 8 groups, 640 open, 71 closed at bootstrap), the flat
visible order equals the oracle's, the settled snapshot equals the rebuild.

| step | oracle changed | committed | reads / budget | layout runs (ids) | groups changed | header redraws |
|---|---|---|---|---|---|---|
| #1 heartbeat | none | 0 | 2 / 3 | 0 | none | 0 |
| #2 phase | i214 | 1 | 1 / 3 | 0 | none | 0 |
| #3 click | i214 | 1 | 1 / 3 | 0 | none | 0 |
| #4 rename | i214 | 1 | 1 / 3 | 0 | none | 0 |
| #5 stage move | i5 | 1 | 1 / 24 | 1 (732) | r1 | 1 |
| #6a new issue | none | 0 | 5 / 16 | 1 (733) | r0 | 1 |
| #6b archive | none | 0 | 1 / 15 | 1 (732) | r1 | 1 |
| #6c evict | none | 0 | 1 / 15 | 1 (731) | r1 | 1 |
| #6d evict keeper | none | 0 | 2 / 30 | 1 (729) | r0 | 1 |
| #7 reparent | i214, i591 (roll-ups only) | 0 (stub) | 1 / 21 | 0 | none | 0 |

Window (web list, container stubbed to the browser driver's 5,800 px):
108 of 732 visible rows drawn; 59 cold rows asked for at first paint (376
with every row drawn, Mb1); 156 rows loaded settling the first window;
distinct per-row feed reads while it settles 482 (389 issue, 93 session)
against Mb1's 1,145 (464, 681) drawing every row. Scrolling to the end draws
the last row; folding a group shrinks the list by its closed rows x 56 px.

L4b gate (`pool/gate.test.ts`, 3 seeds x 200 steps, package config, with the
native lane and residency: 3 files, 21 tests, 939 s): green; the snapshot it
compares with the rebuild now carries the groups. Native (`SectionList`):
draws a prefix of the grouped order, fewer than visible; a heartbeat redraws
nothing, a rename of a drawn row redraws it.

Mutants (each run alone on `groups.test.tsx`, restored with `cp`), all killed:
a header that reads its rows (reads fence, #3: 39 rows, budget 3);
`placement` as a plain `computed` (#3 layout runs 2, expected 0); lanes
without `compareShallow` (#5 header redraws 8, expected 1); the fold sorted
oldest first (bootstrap parity, `r1` closedIds).

## Round three: visible collection and order, b1 (POD-4569) · 2026-09-23

Code: `pool/worklist/visible.ts`. Tests: `pool/worklist/visible.test.tsx`
(parity and fences), `pool/worklist/first-paint.test.tsx` (outside measures).

### Finding: visible rows are mostly COLD

On the live-shaped 1x fixture at `FIXED_NOW`, 376 of the oracle's 732
visible rows are closed issues, which the schema's rule keeps cold. Only 82
are closed top-level rows (68 folded). About 294 are closed CHILDREN kept by
a retained session (mostly idle sessions with no `stoppedAt`, which never
decay) or by the finished-child decay window. So "hot predicate plus the
closed fold's ids" cannot reach parity: the visible predicate must answer
cold rows too. Ma3 finding 4 (four grace rows) was the old fixture. Reported
to the coordinator; design accepted; whether the shared cold rule should
change is POD-4665.

### Decisions

- **R-VIS is the spec's and the oracle's; this file only computes it.** Each
  part cites the legacy line it follows (`rows.ts` flat pass, rescue,
  `nestStartedByIssues`; `visibility.ts`). Two things the spec lists as out
  still decide VISIBILITY in the oracle, so they are computed: started-by
  nesting (an agent-audience row is shown only nested; a parentless
  non-spin-off nests under the present issue owning its `startedBySession`)
  and R3 membership (sessions of `issue.worktree` with no `issueId`).
- **One node per KNOWN issue, hot or cold.** A node's parts read the row from
  the hot table slot, or a cold row by id through the feed (`MobxPool.coldRow`:
  the fenced per-row read, counted, tracked by residency's per-id atom, which
  now reports every relink). Cold rows stay out of the tables and get no
  model; the residency rule is untouched (coordinator condition 3).
- **Session parts are per session** (`SessionNode.retention`, `.activityMs`),
  so a heartbeat re-runs one session's part and stops there.
- **Rescue reads DOWN the children relation** (`keeps` / `keptBelow`), each
  child's cached `keeps`; no walk. The nest parent walks UP the raw
  `parentId` through present checks only (cycle-guarded like legacy).
- **The collection is MAINTAINED**: one reaction per node adds or deletes its
  id in an observable set. Nodes follow the issue records of each event
  (`MobxPool.syncWorklist`); the only whole walk is `knownIssueIds` at a
  `replace`. A re-enumerating computed would count every id (`keys()` reads,
  POD-4621) on every flip: ~2,170 reads on #6 against a budget of 16.
- **Order** is a computed over the set: `compareRank` over each visible
  node's cached `rank` (L1b `rankOf` on the own row), shallow-equal. It reads
  no row and sorts exactly the visible ids.
- **The list draws the order.** A visible cold row is asked for and drawn as
  a bare placeholder outside `RowShell` until its load lands, so its first
  row commit is its data (the addendum's "second paint").
- **The snapshot** is the visible rows in rank order, `pinnedIds` in rank
  order, no groups (Mb2). The rebuild decides visibility from scratch with the
  same part functions (`directVisibility`), over every row the feed holds.
- **A row slot resolves its model on presence change only** (`react/list.tsx`,
  `native/list.tsx`): an outer observer looks the row up (a counted presence
  read) when it mounts or its row loads; the inner one observes the view. The
  first version looked it up on every redraw, and #2 charged the redrawn root
  (`i214`) as a second read.
- **Residency bug found by the gate** (`residency.ts` `observe`): an untracked
  presence check (the gate's relation scan, inside an action) DELETED a cold
  row's atom that a visibility node still observed, so the node never saw the
  row's next change (seed 1 step 6: a mark-read on the hidden finished child
  `i1380` should have made it visible). An atom is now dropped only by the
  call that made it; `residency.test.tsx` "a cold row read by a derivation
  stays tracked..." fails with the old line.
- **Second gate finding: an untracked node registry** (`worklist/visible.ts`
  `VisibleCollection.nodes`). Parts look up other issues' nodes (a parent, a
  child, a starter's owner); with a plain Map, a lookup that missed tracked
  nothing, so an evicted parent re-added (gate seed 1, step 112, shrunk to
  evict + reAdd of `i234`) never re-placed its descendants (5 rows missing).
  The registry is now an observable map. Regression test in
  `visible.test.tsx`; with the plain Map it fails ("rows missing: i355, i368").
  Pitfall (j), in the arm's own memo.
- **Not handled, named**: a started-by nesting cycle (legacy skips the edge
  that would close it, order-dependently); two present issues sharing a
  worktree that owns a starter session (legacy takes its list order, the
  pool the lowest id). Neither is in the fixture or the generator.

### Numbers (1x, `FIXED_NOW`; `harness/browser/results/mobx-visible-*.json`, gitignored)

Parity (`visible.test.tsx`), after bootstrap and after each of #1-#5: 732
visible rows, order equal to the oracle's flat R-ORDER rows, snapshot equal to
the rebuild, 0 own-row field differences.

| step | oracle changed | drawn | reads / budget | order sorts | set flips |
|---|---|---|---|---|---|
| #1 heartbeat | none | none | 2 / 3 (session, worktree) | 0 | 0 |
| #2 phase | i214 | i214 | 1 / 3 (the changed session) | 0 | 0 |
| #3 click | i214 | i214 | 1 / 3 | 0 | 0 |
| #4 rename | i214 | i214 | 1 / 3 | 0 | 0 |
| #5 stage move | i5 | i5 | 1 / 24 | 0 | 0 |

L4b gate (`pool/gate.test.ts`, 3 seeds x 200 steps, heavy lease, 984 s;
`results/mobx-pool-gate-1x-3x200.json`): green. Every seed compares the
settled snapshot (the visible rows, pinned order) with the from-scratch
rebuild at 201 steps and scans every relation at each; the full-residency
checkpoint passes; the removal-deaf, cold-deaf, relink-skipped and
promote-skipped plants fail on every seed. It found two bugs on the way (the
residency atom and the node registry, above). The 20 x 300 gate of record
was not re-run here.

Rank change (pin the last unpinned visible row): one sort of the visible
count, the row moves up, only that row commits. A list that draws every
known issue (the plant) fails the commit fence on #1 and #4 and nothing else.

Bootstrap and first paint, measured OUTSIDE the pool (`first-paint.test.tsx`:
a counting wrapper on `RowSource.row`, MobX's own reaction graph, the DOM):

| | 1x | 4x |
|---|---|---|
| issues / sessions | 4,867 / 4,304 | 19,468 / 17,216 |
| visible rows | 732 | 2,928 |
| visible rows cold at first paint (drawn loading) | 376 | 1,504 |
| cold rows in the first 96-row window | 45 | 17 |
| visibility reactions = IssueNodes (MobX graph) | 4,867 | 19,468 |
| SessionNodes (MobX graph) | 2,641 | 9,415 |
| per-row feed reads at bootstrap (distinct) | 4,710 (2,701 issues, 2,009 sessions) | 17,591 (10,804, 6,787) |
| rows loaded settling first paint (distinct feed reads) | 1,145 (464 issues, 681 sessions) | 4,452 (1,852, 2,600) |
| load windows to settle | 2 | 2 |

Reading: every cold issue is read once at bootstrap to answer its
visibility (its row, and the member sessions the retention part needs), and
every known issue holds a node and a reaction. That is the price of the
schema's cold rule meeting R-VIS on this corpus; POD-4665 decides whether
the rule changes. Mb1 draws every visible row, so all 376 / 1,504 cold
visible rows load at first paint; with Mb2's window only the first
window's cold rows would (45 / 17).

## Round three: a-phase gates, a4 (POD-4568) · 2026-09-23

### Rework after M3 (POD-4591 FAIL) · 2026-09-23

Numbers: `docs/measurements/POD-4568-a.md` §5.

- **F1: buckets are observable sets, updated in place.** The action's moves
  are netted per bucket and applied once: 1 element per edge, and moves
  that cancel out notify nothing. Buckets are unordered. `sessionIds` sorts
  (the draft title's first member needs an order), `members()` returns a
  sorted copy, and `diffRelations` sorts.
  - New counter: `counters.bucketElements`.
  - Armed test: 4,000-member buckets, 1 element per insert and delete. It
    was red on the copy-and-sort code (4,001).
  - Live probe: 4,575 → 1 and 2,264 → 1.
  - Rejected the binary-searched sorted array. Its insert is a splice that
    moves O(b) slots, and MobX's observable array notifies the whole array
    anyway.
- **F2: the views read `one()`.** `repoTarget` (renamed from `repoRef`,
  because `repoId` collides with the row field) and `originRef` (a known
  origin that may be cold, so the loading check stays). The lint forbids
  `views.ts` from importing `relations.ts`.
- **Consequence for the gate's plants.** The views now read the forward
  slots, so the per-step rebuild catches an ISSUE whose promotion was
  skipped (`displayRef` loses its prefix) before the checkpoint can. The
  promote-skipped plant is therefore narrowed to sessions, whose forward
  slots no view reads, so the checkpoint stays proven armed.
- **Open, not mine.** `SliceRow` has no `originTick`, so the rebuild
  comparison cannot see an `issue.discoveredFrom` error through the row
  views. The per-step `diffRelations` does see it. Worth knowing when Mb4
  wires parity.


Numbers and commands: `docs/measurements/POD-4568-a.md`.

### Decisions

- **Scope after the coordinator's correction (2026-09-23):** L4b stays
  rebuild-only (`oracleEvery: 0`); fence steps #1-#3 (and #4, kept from Ma1)
  run through the shared `assertCommits`, `assertReads` and
  `assertNoCopies` without parity; the roster exception stays, naming Mb4
  (POD-4572). #3's budget is 3 (POD-4619), not the brief's 0.
- **#2 failed as found** (base 1cd21c6aa): 4 rows read, budget 3 —
  `s34` (the changed session), its siblings `s35` and `s507`, and `i17`.
  Two parts read every member ROW on any member's change: `activityAt`
  (max over the members' `lastActiveAt`) and the draft title (its first
  member, read eagerly for every issue, draft or not).
- **Fix, in the idiom:** the member's contribution is a computed on the
  member's model (`SessionModel.activityMs`); the issue's parts read the
  bucket once (`sessionIds`, its own `computedStruct`) and walk it; the
  draft title asks for its first member only for a draft. #2 now reads 1
  row (`s34`). The rebuild computes the same functions directly
  (`ViewInputs.sessionActivity`), so the gate holds them together. Nothing
  scenario-specific: every roll-up over members will take the same shape
  (Mb3).
- **A member model built earlier is taken from the identity memo without a
  presence read** (`pool.ts` `sessionActivity`). The fence counts `has` as a
  read of that id; going through `model()` would charge every sibling again.
  Safe because the model reads its own tracked slot (a removed member
  answers null, as before) and the bucket that lists members is tracked.
  The harness doc allows exactly this ("a walk over any other per-row cache
  the arm keeps"); the growth slope and review are its check.
- **Real clock in the fence test** (the roster's conditions since POD-4618);
  Ma1's frozen `Date` is gone.
- **Mounted models now include member sessions**: 2,170 drawn issues +
  1,600 resident member sessions = 3,770 at 1x (Ma3's "models == rows
  drawn" is restated in `residency.test.tsx`).
- **Gate runs hold only the heavy lease.** `test-heavy -- bash -c "bun run
  test:file …"` also takes one of the host's two focused slots for the whole
  run (hours for 20 x 300), which starved my own focused runs; the gate runs
  vitest directly under `test-heavy`, as the repo's heavy scripts do. Bun
  eats the first `--`, so a nested `test:file -- path` must go through
  `bash -c`.

### Findings

1. **The #2 fence cannot see a sibling re-read alone on its target.** The
   budget is 3 per level; `i17` has exactly 3 member sessions, so re-reading
   the whole family costs 3 and passes. The base failed only because a
   second part also read `i17`. Pinned in `counts.test.tsx` (the planted
   pool with member activity read from rows: #2 reads `{session: 3}` = the
   budget). Reported to the coordinator: the target needs a family larger
   than a level's budget for the fence's "a roll-up that re-reads a level's
   siblings ... fails" to hold.
2. **#3 commits 1 row, not the brief's 2.** The fence's click starts with
   no selection, so the oracle changes only the clicked row (`i17`); the
   reference arm's cell is also 1. The two-row case (selection moving) is
   `pool.test.tsx`'s "a click re-derives exactly the old and the new selection".
3. **The 20 x 300 gate found a relation bug Ma3's 3 x 200 run never
   reached** (first run, 2026-09-23 04:26, at e001b958c: `relations
   diverged from the scan (snapshot 126): issue:i80.children: live
   ["i229"], scan []`). Mechanism (`relations.ts` `flush`): a bucket was
   placed by its target's CURRENT residency on every write. A resident
   parent that is removed keeps its observable bucket ("nothing moves
   back"), so the next move of one of its children wrote the plain twin and
   left the observable bucket, which every reader sees first, stale. Fix: a
   bucket is written where it lives; residency places only a bucket that
   does not exist yet. Test: `residency.test.tsx`, "a removed resident
   parent's children follow a child that moves away" (red before the fix
   on `i0`, green after). Reproduced on the pre-fix commit (f739adac9) by a scratch
   probe: seed 8 fails at step 124, as the gate did; seed 8's sequence is
   `evict i80` (step 92), `archive i229` (107, the child leaves `parent`),
   `reAdd i80` (124, the stale bucket is read again). Seeds 1-7 pass there.
   The gate's per-step relation check caught it; the
   rebuild comparison alone would have only if a row view read that bucket.

## Round three: residency, a3 (POD-4567) · 2026-09-23

Cold rows (closed issues and their sessions) stay out of the pool until
something reads them (`pool/residency.ts`; schema doc §5, audit §7).

### Decisions

- **The rule is the schema's, applied by one function** (`coldByRule`): an
  issue is cold when `closedAt != null`; a session is cold when its RAW
  `issueId` names a known issue that is cold by rule. Raw, not through the
  `issue` relation's `where`: residency follows the reference, so a headless
  session of a closed issue is cold too (nothing reads it). The pool, the
  rebuild and the partition check all call `coldByRule`.
- **Cold means not in the observable tables.** A plain registry keeps the id
  (and, for a session, the issue it inherits from, so a reopen finds it).
  No table slot, no model, no observable.
- **Relations of cold rows live in plain twins** (`relations.ts`
  `coldForward` / `coldBuckets`). Without them the relation layer alone
  built ~10k observables for cold rows at 1x (24.7k total vs 29.6k with every
  row resident, i.e. only -17%). A cold source's forward entry and a bucket
  keyed by a non-resident target are plain; buckets of resident targets hold
  hot and cold member ids alike (the brief's "buckets hold ids regardless of
  temperature"). A row that becomes resident has its slots moved into the
  observable maps (`promote`, one slot write each). A reader that reaches a
  plain slot observes that row's residency atom and every plain write reports
  it, so the read is tracked (pitfall j).
- **Residency checks are tracked without an observable per cold row.** Each
  `entity:id` a derivation asks about gets an atom on that first question,
  dropped when unobserved (observability on first access, applied to
  residency itself).
- **First access = a derivation reading through a lazy relation.**
  `ViewInputs.loading(entity, id)` answers true for a known cold row and
  queues it; the first request arms a 50 ms window (`LOAD_WINDOW_MS`); every
  row queued inside it is read by id through `RowSource.row` and installed in
  ONE action (`MobxPool.hydrate`). Duplicates coalesce. A derivation cannot
  write state, which is why the load is deferred at all.
- **A cold row that receives an update stays cold** (relinked, not stored;
  the kernel holds the value and a later load reads the current one) —
  UNLESS the update makes the row itself not cold (a reopen): it is installed
  at once, and the sessions that inherited coldness from it are read by id
  and installed in the same action (`warmDependents`). A removed issue warms
  its cold sessions too (nothing makes them cold any more). Chosen so a
  heartbeat on a closed issue's session costs a registry write, never a
  load, and a reopen never paints loading.
- **Nothing makes a resident row cold except a `replace`.** An issue closed
  while resident stays resident (it was just looked at). `replace`
  re-partitions: a row resident before and still in the slice stays; every
  other row follows the rule over the new slice.
- **`RowView.loading?: true`** (shared contract, coordinator yes): set while
  the origin or a member session is known but not resident; `originTick`,
  `activityAt` and a draft's title are provisional exactly then. `loadingPartOf`
  asks about EVERY member so all of them load in one window. `sliceRowOf`
  drops it. Divergence from legacy (which never shows loading) pinned into
  POD-4596 by the coordinator.
- **`RowSource.row?(kind, id)`** (shared contract, coordinator yes): per mode
  exactly as `snapshot(kind)` for one id (`row-source.test.ts`), counted by
  the fence as one keyed read of that row (`residency.test.tsx`).
- **Lazy collections: `MobxPool.lazyMany` → `{ ready, pending }`** (criterion
  3 at the relation level, coordinator yes). Mb3 derives progress from
  `ready` and sets `loading` while `pending > 0`.
- **`snapshot()` settles**: it reads every resident row, loads what they
  queued, and reads again until nothing is queued (bounded, 64 rounds).
- **The rebuild's rows**: the issues the rule keeps hot, plus the pool's
  resident ones (a residency local, like selection); every row reads full
  data. The coordinator's safeguard against that input is below.
- **The arm refuses a feed without `row()`** rather than silently holding
  every row.

### Numbers

Bootstrap in the count harness (`pool/bootstrap.test.ts`, replay feed,
`results/mobx-pool-bootstrap-counts.json`). "Observables" are MobX's own
`spy` "add" events during `create()`: every map slot built (tables, forward
entries, buckets). Models built: 0 in every cell.

| Scale | Pool | Issues resident / cold | Sessions resident / cold | Table slots | Observables |
|---|---|---|---|---|---|
| 1x | lazy (Ma3) | 2,170 / 2,697 | 2,032 / 2,272 | 4,202 | **15,547** |
| 1x | every row resident (Ma2) | 4,867 / 0 | 4,304 / 0 | 9,171 | 29,636 |
| 4x | lazy (Ma3) | 8,680 / 10,788 | 8,184 / 9,032 | 16,864 | **62,622** |
| 4x | every row resident (Ma2) | 19,468 / 0 | 17,216 / 0 | 36,684 | 119,232 |

-48% (1x) and -47% (4x). The 4x all-resident count (119k) is Linear's
80-100k range; the lazy pool keeps it at 63k.

- **Observability on first access** (`residency.test.tsx`): after bootstrap 0
  models; with the web list mounted, models == rows drawn == 2,170 (every
  resident issue; no cold row drawn or modelled).
- **Loader** (`residency.test.tsx`): two rows asked for inside one window →
  one timer at 50 ms, one `row()` read each, one action, both resident; the
  reader saw `loading` then the row, never an empty row; a hydration counts
  as exactly one fenced read (`rows: 1`, `issue: 1`).
- **Fence steps** (`counts.test.tsx`): #1's COMMIT fence is asserted again —
  the heartbeat's closed root and its session are cold, so the heartbeat is a
  registry write and the a1 list never drew the hidden row Ma2 redrew. #4
  still redraws an open hidden spin-off (`i933`): Mb1's.
- **Correctness gate** (`gate.test.ts`, `results/mobx-pool-gate-1x.json`,
  seeds 1-3 x 200 steps, 729 s at load ~8-9, green): every step compares the
  settled snapshot with the rebuild, every relation of every known row
  (cold included) with a scan, and the hot/cold partition with the feed; the
  last step runs the full-residency checkpoint. Cold-row work after
  bootstrap, per seed: registry writes 63 / 79 / 70, rows warmed by a reopen
  or removal 12 / 11 / 10, loads on access 27 / 0 / 0 (seeds 2-3 load only at
  the checkpoint: no drawn row reached a cold one). Plants, each failing
  every seed: removal-deaf (steps 15 / 56 / 21, rebuild); cold-deaf (9 /
  26 / 7, partition then relations); relink-only with the checkpoint off (31
  / 26 / 8, the per-step relation check); promotion-skipped with the
  per-step checks off (the checkpoint, at step 199).
- **Bootstrap walls**: NOT MEASURED. One attempt, 2026-09-23 03:56, under
  `bench:ludovico`, lazy and all-resident interleaved (15 rounds, order
  rotated, `POD_POOL_BOOT_WALLS=1 ... bootstrap.test.ts`): FAILED by the load
  rule at both scales (1x max load 8.10, 4x max 9.14; uptime before 8.39,
  after 9.12). No summary is kept. Re-run on a box below load 8; the browser
  wall waits for L5e (POD-4561).

### Findings

1. **Loading a row relinks it from its current value, so a relation error
   confined to a cold row heals when the row loads.** The coordinator's
   full-residency checkpoint (load everything, compare with no pool input)
   therefore cannot see that class: the first checkpoint plant (skip relinking
   for cold updates) passed it. The class IS caught by the per-step relation
   check, which scans the feed's rows and reads no residency from the pool
   (`coldRelinkSkipped`, asserted every seed). The checkpoint's own plant is
   one that survives loading: promotion skipped (`promoteSkipped`).
2. **The checkpoint cannot run when an arm is disposed on a reload**: the
   checker has already replaced the engine, so the old arm's feed is dead
   (its first version failed with every relation "live null"). It runs at the
   run's last compared step, before that step's snapshot.
3. **The feed's lanes include discovery-only ones it never announces**
   (POD-4606, L3c), so a relation scan over the feed's lanes flags the pool
   for a lane it was never sent. The scan (`knownTables`) takes the feed's
   rows for the entities that can be cold and the pool's own lanes and repos,
   as Ma2's check did.
   CLOSED by POD-4606 (ca53a62d5): the feed now announces discovery-only
   lanes and repo roots. The check still reads the pool's lanes (POD-4568's
   gate of record ran on that input); switching to the feed's lanes is Mb4's
   (see `enumerate.ts` `knownTables`).
4. **Visible rows can be cold.** A closed top-level issue inside the 24 h
   grace window is still drawn (not folded yet), yet the schema's rule makes
   it cold, so it will load on first paint (loading, then data). At 1x that is
   the four #8b grace rows. The rule is the schema's (coordinator's call);
   noted for Mb1/Mb2.
5. **Corpus shape for lazy relations** (1x / 4x): no open issue has a closed
   origin, so nothing a1's list draws reaches a cold row and mounting queues
   nothing; 524 / 2,062 open parents have closed children (Mb3's pending
   progress); 269 / 1,038 open issues have a closed parent.

### Open

- Bootstrap walls in the browser wait for L5e (POD-4561).
- Mb3: progress from `lazyMany(...).ready`, `loading` while pending.
- Mb1/Mb2: the closed fold lists ids from metadata and loads rows only when
  drawn (the brief's pitfall); finding 4's grace rows.

## Round three: relations, a2 (POD-4566) · 2026-09-23

### Decisions

- **One engine, no relation named** (`pool/relations.ts`). Links are built
  from `schema[entity].relations` at construction; each single-valued
  relation owns an observable `forward` map and the observable `buckets` of
  its inverse. A fixture schema with one extra relation
  (`issue.coordinator` / `session.coordinates`) is maintained with zero
  code change (`relations.test.ts`).
- **`one()` reads the forward map, not the row.** Ma1 resolved `belongsTo`
  from the own row; that answers correctly only while nothing but the row
  decides membership. The resume-twin collapse and the prefix relation are
  decided by OTHER rows, so every single-valued answer now comes from the
  maintained forward map plus the target's presence: one counted read. The
  row views keep Ma1's `relationRef` reference/resolution split for
  `issue.repo` and `issue.discoveredFrom` (ruled acceptable; the engine
  computes its forward key with the same function).
- **Buckets are keyed by the reference, not by the target's presence.** An
  evicted parent keeps its children's bucket; a re-add reads it back. A
  holder of a deleted target keeps its reference id; `one()` answers null
  until the target returns (doc §4.3).
- **Bucket order is session/issue id order** (sorted on flush). History-free,
  so the rebuild and the live pool agree on a draft's "first member". The
  legacy order is the runtime's list order, which no pool has.
- **One flush per action.** Moves collect in per-bucket pending sets; the
  flush writes each touched bucket once, and not at all when its content
  ended unchanged. A two-row push into one parent invalidates a reader of
  that bucket once (`relations.test.ts`).
- **Prefix without a scan.** A `prefix` link indexes each member under every
  ancestor of its normalized path (`under`). A new root reads
  `under[root]` and takes members at a shorter root or none; a removed root
  hands its members to one probe of its own ancestors (their next root is
  the same for all). Probes ask the RAW table (a miss reads no row) and count
  the hit.
- **Resume twins declared once, in the shared schema** (`session.collapse`,
  `collapseLosers`; doc §4.6). Ha2 consumes that declaration. A collapsed row
  contributes no edge. Exact rank-and-recency ties keep the lower session id
  (the legacy keeps list order).
- **The rebuild resolves relations from scratch** (`scanRelations` in
  `enumerate.ts`, the one walking module): the declared resolvers over
  whole tables. The gate additionally holds every relation of every row to
  that scan at every compared step (`gate.test.ts`).
- **A repo survives while any of its lanes remains** (`tables.ts`
  `releaseRepo` asks `repo.worktrees`); Ma1 dropped it with its holding lane.
- **`tracked()` rethrows** an error thrown inside its transient reaction;
  before, MobX swallowed it and the caller saw "ran inside a batch".
- **Roster exception** now names POD-4572 (Mb4), per the coordinator.

### Numbers (1x corpus: 4,867 issues, 4,304 sessions, 468 lanes)

- **L4b gate** (`gate.test.ts`, `results/mobx-pool-gate-1x.json`): seeds
  1-3, 200 steps each, rebuild compared after every step (201 checks per
  seed) and every relation of every row held to the scan at every one of
  those checks; the removal-deaf plant fails every seed (steps 15, 37, 7).
  Oracle comparison stays off (`oracleEvery: 0`): order and roll-ups are
  Mb1-Mb3's. 475 s for the file at load ~7.
- **Relation tests** (`relations.test.ts`, 40 tests): per relation, twins,
  the doc §4.5 example (including its write record), 12 change kinds each
  asserting the exact relation slots written, the fixture schema, and 8
  seeded random runs x 300 steps over a colliding id universe against the
  scan (worktree removal, cwd moves, session re-homing, deps changes and
  twin flips, which the L4a generator does not draw).
- **Fence steps** (`counts.test.tsx`, `results/mobx-pool-counts-1x.json`):
  #1 heartbeat reads 2 rows (budget 3), writes 0 relation slots; #4 rename
  reads 2 (budget 3). A lookup through the fenced reader: `one` 1 read,
  `many` 1 per member, `size` 0 (`relations.test.ts`).
- **#1's commit fence moved to Mb1, like #4's.** The heartbeat's issue
  (`i1211`, a closed agent-audience root) is hidden in the worklist; with
  `issue.sessions` maintained its `activityAt` moves, and the a1 list draws
  every issue, so the one drawn row is that hidden row
  (`oracleVisible: {i1211: false}` in the results cell). The native lane
  test now expects exactly that one row.
- Per compared gate step (dev timing at load ~8, not evidence): snapshot
  ~250 ms (~170 ms of it before relations answered anything), rebuild
  ~80 ms, relation diff ~110 ms.

### Findings

- The warn trap throws INSIDE MobX when a reaction reads nothing
  (`reactionRequiresObservable`); the throw escapes MobX mid-batch and
  leaves global state broken for later tests in the file (they then fail
  with "ran inside a batch"). Seen once while writing a test; the fix was
  the test (call the throwing reader outside a reaction).

### Open

- Residency (cold rows, lazy relations) is Ma3's; the engine maintains
  every row the feed delivers.
- POD-4621 (fence `keys()`) has not landed; `issueIdsOf` keeps Ma1's
  raw-keys-plus-`touch` workaround.

## Round three: the pool, a1 (POD-4565) · 2026-09-23

Decisions, findings and open questions for `pool/`. The idiom, write path,
stats and "how to add a field" are in `README.md`.

### Decisions

- **Placement (coordinator ruling on my question).** The pool lives in
  `arms/mobx/pool/`; the round-two files stay frozen until the pool's
  worklist replaces them (the browser entries and the native lane still import
  them). The lint thaws `mobx/pool` (`fenceConfig({ thawed })`), so every
  fence rule runs on the pool against `arms/mobx/fence.json`, plus an IMPORT
  FENCE (`fence/thawed-import-fence`): nothing in `pool/` may import anything
  under `arms/` outside `pool/` (type imports, re-exports and dynamic imports
  included), proven red on planted files in `harness/lint/fence-lint.test.ts`.
  The roster check names `mobx` as pending until POD-4568 (Ma4) adds the
  roster entry with parity.
- **Tables are shallow observable maps of borrowed rows; models on first
  access.** One `ObservableMap` per schema entity (one box per row, no
  per-field observables, no model). Bootstrap builds zero models
  (`pool.test.tsx`); the first read builds one. A model holds no row: it
  reads its table slot, so evict → re-add reaches the same observers
  (`pool.test.tsx`, "removes a row with its model…").
- **The model cache is a plain `Map` read inside derivations.** It is an
  identity memo only: a model's every value reads the tracked slot, so the
  cache cannot make a derived value stale. The one other untracked read is
  the clock's `now` (`clock.ts`), paired with an atom for every answer.
- **Every part of a row view is its own computed, and a relation is split
  into reference and resolution** (`views.ts` `IssueParts`). Measured on the
  live 1x engine, #4 (rename of `i17`, which has an origin and a hidden
  spin-off): one view per part read 9 rows; splitting the view into parts
  read 5; splitting each relation into its foreign-key reference and its
  target resolution, and handing each slot its model, read **1** (budget 3).
- **Single-valued relations (`belongsTo`, outgoing `edge`) are resolved from
  the own row plus the target's presence** (`relations.ts` `relationRef`,
  driven by the schema). No bucket is maintained; the coordinator's "no
  hand-written buckets in a1" holds. `displayRef` (`issue.repo`) and
  `originTick` (`issue.discoveredFrom`) are real one-hop values, not stubs.
  Collections and prefix containment answer "none" through the shared
  `RelationReader` until Ma2 (POD-4566), which can reuse `relationRef`.
- **The repo entity's row is a lane.** The feed has no repo kind: every lane
  (`SliceWorktree`) carries its repo's joined facts (RepoProjection id and
  prefix, the scan's path). The latest lane with a `repoId` is the repo's
  row; a raw repos row (the feed's signal for a repo with no lane yet) is
  held until a lane arrives. `FEED_SPELLING` maps the repo's `path` to the
  lane's `repoPath`.
- **The clock is deadlines** (`clock.ts`): a tick fires only the deadlines it
  crosses (binary search over the registered ones); a rewind fires one atom.
  Replay corpus at 1x (`pool.test.tsx`, `harness/browser/results/
  mobx-pool-tick-1x.json`): 18 deadlines registered over 4,867 issues; a
  60 s tick then a 24 h tick: the 24 h tick crossed 4 deadlines,
  re-derived 4 views and changed 4 (#8b's four grace rows).
- **Selection is a one-entry observable map**: a click re-derives exactly two
  views (`pool.test.tsx`).
- **Replace** runs the new slice through the same ingest into plain maps,
  then keeps unchanged objects, writes the changed, removes the rest, all in
  one action: one observer transition (`pool.test.tsx`).
- **L4b rebuild-only at a1** (`oracleEvery: 0`, ruled acceptable): the
  oracle compares order and roll-ups. The gate's NO on this arm is the same
  pool planted deaf to removals, which must fail every seed. Measured with
  `POD_POOL_GATE_SEEDS=5` (seeds 1-5 × 200 steps, every change kind, 1,005
  rebuild comparisons, 2-7 arm creations per seed from reloads): green; the
  plant failed every seed, at steps 15, 37, 7, 3 and 1. The default run is
  seeds 1-3 (~3 min).
- **Round-two `it.fails` tests stay** (18, POD-4551): the pool does not
  replace the round-two code yet. They go with that code.

### Findings

1. **(Resolved by POD-4621, applied in Ma3.)** **The fenced table's `keys()` reads every VALUE** (`reads.ts` `wrapMap`
   iterates `entries()`). Under MobX that subscribes the enumerating computed
   to every row, so a rename would re-run the id list and read the corpus.
   `enumerate.ts` iterates the raw map's keys (tracks membership only) and
   records each id with `reads.touch`. A fence change (`keys()` over
   `target.keys()`) would let arms use the fenced view directly — L5a's call.
2. **A repo read costs two fence keys** (`repo:<id>` for the table get,
   `worktree:<lane path>` for the lane proxy's fields), because the feed
   delivers repo facts on a lane. It shows only when the prefix resolution
   re-runs (a repo or a lane change), never on an issue change.
3. **The 1x fixture's `sliceWorktrees` carry no repo-root lanes; the live
   feed does** (`row-source.ts` `lanesOf`). A repo taken from root lanes only
   worked live and silently gave every replay row `#seq`; the pool takes any
   lane with a `repoId`.
4. **`ObservableMap.has` outside a reaction does not warn** (MobX's untracked
   shortcut), so `observableRequiresReaction` cannot see an untracked
   presence check. The pool reads presence only inside computeds.
5. **An `observer` row over a plain `RowView` observes nothing** and trips
   `reactionRequiresObservable`, which the pool's tests enforce, while
   `eslint-plugin-mobx` `missing-observer` wants every component to be one.
   The two row files (`pool/react/row.tsx`, `pool/native/row.tsx`) are
   `memo` and exempt from that one rule in `eslint.config.mjs`; their slots
   are the observers.
6. **#4's commit fence needs the visible set.** The a1 list draws every
   issue, and #4's rename changes the ⤷ tick of a HIDDEN spin-off (`i933`),
   which the fence counts as an over-commit. The pool's own view of `i933`
   really changed. `counts.test.tsx` asserts the commit fence on #1 only and
   writes #4's cell; Mb1 asserts it.
7. **`snapshot('worktree')` omits raw repos rows** (`row-source.ts`
   `allLanes`), so a repo known only from a raw row would diverge between the
   pool and its rebuild. No generator change produces one today.
8. **Base defect, not mine:** the package `NOTES.md` carries two stray
   conflict markers (`||||||| parent of …`, lines 69 and 103), landed by
   `8d82d8dd0` (POD-4609). Reported to the coordinator.

### Open

- Draft titles read the first member session's `name` in round two; the
  schema declares no `session.name`, so the pool's draft label uses
  `agentKind` only. Matters from Ma2, when members exist.

## Round two (frozen)

## Decisions

- **Tracked object graph, not a port.** Each issue is an `IssueModel` with
  observable `value` (`observable.ref`: the borrowed row, never spread) and
  computed getters (`flat`, `visible`, `summary`, `aggregate`, `tick`,
  `rankKey`, `closed`, `isSelected`, `row`); sessions and worktrees are leaf
  boxes. Relations run through the graph (`issue.parent/children/sessions/
  origin` read the store's buckets, so reads flow to the calling computed and
  no intermediary identity ever propagates spuriously). There is no
  whole-worklist computed and no `keepAlive` — the round-one mistakes, named
  in methodology §3, are absent by construction.
- **Read as late as possible.** Every computed checks cheap structural gates
  first and reads volatile fields and `coarseNow` only on paths that need
  them (defer carriers for bands, finished members for decay, settled rows
  for the fold grace and selection). MobX subscribes a computed only to what
  its body actually read, so the unrelated heartbeat invalidates nothing and
  a deep change re-runs exactly the ancestors until values settle
  (structural/shallow equality stops the propagation; sibling row objects
  keep identity — asserted with `toBe` in the depth-3 test).
- **Row-replacement granularity is inherent to the stream.** `apply` swaps
  the whole borrowed row object, so every computed that read the old object
  re-runs on any field change — even `readAt`-only mark-reads re-run the
  flat + summary + aggregate input checks (3 evaluations, zero value
  changes, zero commits). The hand arm counts the same 3 for the same input;
  the numbers coincide for the same reason.
- **Unread is derived, never trusted from the wire** (`derivedUnread`
  replays the replica rollup; archived sessions sit in explicit seats and are
  filtered at read — one seat system, two reads, same as the hand arm).
- **Awaiting-merge never fires; merge decisions never fire.** Both read
  `branch`/`gitState`, which the navigation model never carries — the arm
  matches legacy (spec: legacy wins over shorthand). Defensive reads
  (`busy`, `name`, `supersededBy`, `duplicateOf`) mirror the hand arm's open
  H4 question #5.
- **Engine rows omit open `closedReason` (undefined, not null).** Every
  finished check uses loose `!= null` (verified against the cited
  `session-status.ts:463` and `row-attention.ts:51`). Strict `!== null`
  failed SMALL parity on i7/i8/i9 (a finished+offerOnly misread plus phantom
  done units) — the oracle diff pinpointed it in one run.
- **Rescue/hosting is guarded recursion with least-fixpoint semantics.**
  Keeper edges point down, hosted edges point up; an evaluation-stack guard
  reads in-progress rows as invisible instead of throwing MobX's cycle
  error. On a forest this coincides with the iterative fixpoint. Fixture
  probe: 0 parentId cycles, and 0 eligible-but-flat-false rows with
  agent-only descendants — the theoretical divergence shape (an agent as a
  row's only keeper) does not occur in the corpus. Documented here, not
  hidden.
- **Snapshot is the unselected baseline in practice, live locals in code.**
  `snapshot()` reads live selection like the hand arm; every parity test
  holds selection null, so both match the oracle's `(null, false)`.
- **Derivation counters are observation-driven.** `rollupsDerived` counts
  `flat` + `summary` + `aggregate` body executions; `rowsDerived` counts
  committed rows (JSON-compared, removals included) plus tick rides;
  `indexUpdates` counts mutating bucket writes; `notifications` counts
  dispatches including no-ops. Unobserved computeds suspend, so count
  assertions live in mounted tests; bare-store tests assert values plus the
  eager counters. Bootstrap counts reset after construction.
- **Native renders full in a ScrollView for M1** (same as the hand arm and
  the control lane, so counts compare directly); the web list is windowed
  (fixed heights + overscan, full-render fallback at height 0 — no new
  windowing dependency, same call the hand arm made).
- **ESLint instead of the standard TS parser.** typescript-eslint refuses
  the repo's TypeScript 7 compiler and no TS-based parser can work with it
  (the Go compiler exports no parser API), so the folder-local flat config
  parses with Babel (7.x line — 8.x breaks JSX) and enforces the two mobx
  rules. Neither rule needs type information.

## Count tables

### 1x engine-backed (GROWTH_CORPORA.x1; 4,867 issues / 4,304 sessions / 500 repos; 3,332 visible rows; `mobx-1x-counts.json`, gitignored)

| Scenario | Rows committed | rowsDerived | rollupsDerived | indexUpdates | notifications | Parity |
|---|---|---|---|---|---|---|
| #1 unrelatedHeartbeat | 0 / 3332 | 0 | 0 | 0 | 1 | green |
| #2 visibleSessionPhaseChange | 1 (i0) | 1 | 3 | 0 | 1 | green |
| #3 selectionClick (engine path) | 0 | 0 | 3¹ | 0 | 1 | green |

¹ The eager mark-read row replaces i1's row object: its flat + summary +
aggregate input checks execute and prove zero value changes.

### UI click path (happy-dom, `mobx.ui.test.tsx`)

| Action | Rows committed | rowsDerived | rollupsDerived |
|---|---|---|---|
| setSelection A→B | 2 (A, B) | 0 | 0 |
| Phase change on B (chain A+B) | 2 (A, B) | 2 | 4² |
| Depth-3 change (chain L+C+P+R, S untouched³) | 4 | 4 | 6 |

² B: flat + summary + aggregate; A: aggregate only (A's flat/summary read
A's own sessions and never invalidate).
³ S's row object is identical before/after (`toBe`); the chain bodies are L's
flat + summary + aggregate plus one aggregate per ancestor.

### SMALL engine-backed

Identical shape at 37 visible rows: heartbeat 0/0/0/0, phase 0 + 0/3
(POD-4496: s0 flips but i0 stays working via R3 s6/s48 — oracle changes
0 rows, arm commits 0; the 3 input checks still execute), click 0 + 0/3,
parity green throughout.

### G2 fixture at 1x (engine-booted, `mobx.fixture.test.ts`)

211 visible rows — full-snapshot deep-equal with `snapshotFromStore` (rows,
order, groups). The corpus the browser pages measure.

### Browser (1x click; `mobx-1x.json`, gitignored; lease held by the driver)

- Readiness + parity in Chromium: the mobx page boots at 1x fixture and
  `snapshotHash` **matches the control exactly** (`f2b677f0`, 211 rows each,
  same session — hashes drift with wall-clock `coarseNow` across boots, so
  the comparison is only meaningful back-to-back).
- Stock driver, same-row clicks, n=25, load 6.36–6.40 throughout:
  p50 10.0 / p95 24.8 / max 34.5 (cold #0 210.1 with the single longTask;
  warmed n=24: p50 10.0 / p95 24.8 / max 34.5). Budget p95 ≤ 16: NOT MET —
  and not meetable here by any arm (see below).
- Alternating real-flip clicks (i300↔i2, selection verified 0→1 in-page):
  19–35ms input-to-paint, n=24, load ≤7.1.
- Frame floor: no-op double-rAF in-page measures 12–34ms (~30fps headless
  SwiftShader); the control's no-op clicks measure 15–19ms. Input-to-paint
  is frame-bound in this harness — every arm and the control share the
  floor, so the 16ms budget cannot discriminate arms here. It needs a 60fps
  environment (or a frame-excluded task metric) to be meaningful.
- The arm's own work per flip, measured synchronously in-page (dispatch
  only, no rAF): 3.9ms cold → 0.4–0.8ms warmed. Sub-millisecond warmed;
  frames and 211-row paint own the rest.
- Two harness-wide observations (all arms + control, not arm defects):
  1. `commits=0` on every browser click while the DOM provably flips
     selection — the production Profiler/log path records nothing in
     Chromium (happy-dom counts are unaffected and exact). Likely a G4
     follow-up, not per-arm work.
  2. Full 211-row mount on load (windowing engages on first scroll) —
     identical on the hand page in this environment; effect-vs-layout race
     at mount, harness-wide.

## Line count (arm folder, `wc -l`; tests excluded)

2,484 total / 1,954 code-only vs the 800–1,500 budget — OVER, openly.
Breakdown (total): rules 571, store 821, models/issue 460, react 187,
worklist 115, native 78, arm 50, config 25, session/worktree 41, README 95,
eslint config 41.

Where the weight is: the same faithful rule transcription the hand arm
carries (decay windows, spin-off tips, rescue, fold grace, prefix
containment, defensive wire reads), plus bucket ingest that mirrors the
hand arm's seat semantics. The MobX saving is real but partial: no delta
union, no level modules with apply/rebuild duplication, no rebuild oracle —
one computed path instead of incremental + from-scratch. Further compression
is comment-trimming and ingest-sharing, not structure — deferred to H4
review (open question 1 below, shared with the hand arm).

## M2 record (POD-4451)

Count harness at 1x (`mobx.m2.test.tsx`, `PROTO_M2_STRICT=1` green):
rename 2 (i0,i1) / 2+3 (POD-4491/POD-4496: i1 R4 tick, allowed over-commit —
tick UI-only, outside the SliceSnapshot oracle), stagemove 1 (i3) / 1+3,
new 0 / 1+3, archive 1 (i3) /
2+1, evict 0 / 1+1, reparent 2 (i2,i8) / 2+5, clock 0 / 0+404 (notifications
0 — locals dispatch nothing), optimism 0 per step with model kept and echo
value restored (press2 two dispatches, rollback quiet), burst50 21 / 32+138
with one notification. Parity green on every step; over-commit only the
documented #4 i1 tick. Visible rows 3,332 at 1x (POD-4496 R3 dual-carry;
was 3,230 while the oracle was R3-blind). #7
commits the same rows with the same counts as the hand arm (2 [i2,i8] /
2+5), #10 the same counts (21 / 32). Full
table + scan judgments in `docs/measurements/POD-4451-m2.md`.

- **Stale `resolveNeeded` (the one mechanism fix).** Bootstrap's ingests set
  the flag and nothing consumed it (`stats.reset()` clears counters, not the
  flag), so the first post-mount event ran one full redundant unbound
  re-resolve: 4,304 home visits + 614k root spreads for zero seat changes
  (M2 #4 before-table). Fix in the idiom: the consumer clears the flag —
  `resolveAllUnbound` sets `resolveNeeded = false` at entry, so bootstrap,
  replace and the gated update path stay consistent. After-table proves it:
  #4 scans drop to `move-seat-scan` + `groups-bucket`, every count
  identical. No new place to remember (inside place #4).
- **`assertNever` in `tableApply` (H4 R-H3, shared with the hand arm).** A
  new stream kind is now a compile error, not a silent fallthrough. One
  line, no new place to remember.
- **Scan instrumentation (no behavior change).** `MobxScanName` + counters
  beside `ArmStats`, cleared on reset. Biggest slope item named removable
  (`move-seat-scan`: O(repo buckets) per issue ingest — targeted-seat
  tracking, J-phase); `roots-spread`/`resolve-unbound` priced for lifecycle
  (J-phase M3); the V-scale list walks judged inherent. Extends place #4.
- **Line growth M1→M2: +65 non-test lines** (`store.ts` +59, `worklist.ts`
  +6) — all instrumentation + the two hardenings above; no derivation logic
  changed. The M1 size gap vs the hand arm survives (~2,420 vs 3,589).
- **Clock finding F-clock with both halves measured** (`mobx.clock.test.tsx`
  on the fixture corpus, the corpus the browser measures). +60s: 3,589
  settled bodies (3,499 flat + 86 summary + 4 aggregate), 0 commits —
  finished-member retention subscriptions stay live forever. +60d: exactly
  the 14 band-movers commit, parity green — subscription completeness has
  value (no stale rows by construction; contrast the hand arm's 3
  hand-maintained sensitivity sets). Quantum fix deferred to J-phase; full
  write-up in `docs/measurements/POD-4451-m2.md` §4.
- **Seed observation for the coordinator.** Scenario-seed dep edges look
  inert on the scenario path (`issueDep` vs the `issueDeps` address);
  R4 coverage comes from the fixture + unit paths. No verdict impact.

## M3 record (POD-4454)

`mobx.m3.test.tsx` green: lifecycle (cold 1x 3,332 visible / 4,867 issues /
4,304 sessions, parity; fresh-replica principal switch 37 visible, parity;
literal 2x rescope 4,867→9,734→4,867 issues with parity at every state;
post-dispose heartbeat touches nothing — issues/sessions 0, notifications
flat), growth 1–3+5 at 1x/2x/4x flat (table + slopes in
`docs/measurements/POD-4454-m3.md`), coexistence heartbeat+click byte-equal
solo counts both sides with parity green. Full tables + JSON in the m3 note.

- **Clock verdict: inherent, bounded, CPU-only (F-clock closed).** The +60s
  tick still re-runs 3,589 settled bodies and commits 0 rows / 0 renders
  (`mobx.clock.test.tsx` pins it). Mechanism: any flat/summary whose row holds
  a finished member subscribes to the coarse clock through its retention check
  and stays subscribed — automatic tracking is correct to subscribe (the +60d
  jump commits exactly the still-visible band-movers, no stale rows by
  construction). Removing the subscriptions means hand-maintained sensitivity
  sets, i.e. becoming the hand arm; the cost is pure-function bodies settling
  by equality, bounded by rows holding finished members. Stated plainly as the
  comparison's largest behavioural difference.
- **Growth slope: counts PASS (0.25 / flat, budget ≤ 1.2); two O(N) cached
  walks named for the browser re-run.** `groups-bucket` visits equal visible
  rows exactly (3,332 / 6,666 / 13,331) on #2/#3/#5: one row's `closed`
  moves → the groups body re-buckets N cached rows on the read path (order
  does NOT re-sort — no `order-sort` scan; rankKey is phase-independent).
  `move-seat-scan` (M2 residual R-M1) walks repo buckets per issue ingest
  (975 / 1,950 / 3,900). Both are CPU-only, zero commits. Whether the
  re-bucketing breaks the wall-slope budget is POD-4489's leased measurement;
  the phaseMs proxy (happy-dom, load-contaminated) is rollup-dominated
  (~97–98%) at 1x and 4x.
- **Stats split (arm-local, no shared/ change).** `store.phaseMs()`:
  `apply()` wall prices eager index maintenance (derivations are lazy),
  flat/summary/aggregate/order/groups bodies price rollup, row/tick assembly
  tails price row — non-overlapping by construction, cleared by
  `stats.reset()`. +~1.1 kB raw / +0.18 kB gzip over the M2 chunk.
- **Seed-stale SMALL #2 count (NOT chased).** `mobx.engine.test.tsx:81` and
  `harness/native/mobx.native.test.tsx:72` expect SMALL phase → 1 commit;
  the current seed resolves unbound sessions s48+s6 onto i0 (both working),
  so s0 working→idle leaves i0's aggregate unchanged — the oracle itself
  changes 0 rows (`oracleChangedRows []`), parity green, store re-runs
  exactly i0's 3 bodies and settles. Hand native passes only by asserting
  parity alone. Both files left red-as-stale, coordinator mailed (POD-4286),
  direction requested; the m3 note carries the milestone verdicts.
- **Line growth M2→M3: +~240 non-test lines** (phaseMs timers + m3 test;
  spike/ excluded, never imported by production). Bundle delta gzip
  +19.72 kB over control (budget +60 KB — PASS).

## Open questions for H4

1. Line budget vs fidelity (shared with the hand arm): is ~2,000–2,800
   lines acceptable for a parity-exact slice, or should M2 compress (and
   what may be dropped)? The MobX arm is ~30% smaller than the hand arm for
   identical parity.
2. The guarded-recursion divergence shape (agent as a row's only keeper):
   accept the documented least-fixpoint semantics, or fund the
   subscription-complete variant? No corpus occurrence found (probe above).
3. `rollupsDerived` semantics: flat + summary + aggregate bodies, matching
   the hand arm's classification. Keep, or split classification from
   derivation?
4. Defensive wire reads (`branch`, `gitState`, `name`, `busy`,
   `supersededBy`, `duplicateOf`) absent from `SliceIssue` but present on
   engine rows and required for parity — shared with the hand arm's
   question #5: grow the slice type or keep defensive reading?
5. Native windowing: ScrollView-full matches the control lane for M1;
   FlatList recycling deferred to M3 like the hand arm.
6. `packages/worklist-proto/tsconfig.json` `include` covers `arms/*/src`
   but not `arms/hand/*.ts` — the hand arm's non-test sources may not be
   typechecked at all. This arm adds its own folder (`arms/mobx`) to
   `include` and proves coverage (a type error there fails the gate).
   Worth a coordinator-owned fix for the other arms?

## Mc3 (POD-4575) MobX lifecycle walls · 2026-09-26

Lane: arms/mobx lifecycle + bootstrap (coordinator: Mc3 owns these; POD-4702
owns pool/worklist/groups.ts + harness/lint — mail before touching those).

Starting point (Mb4 POD-4572-b, flatblock, 1x, n=20/cell): coldBootstrap
mobx 775.7 vs control 214.5 ms p50 (3.6x, budget 1.1x OVER); principalSwitch
639.8 vs 254.0 (2.5x, budget 2x OVER); retained heap 81.07 vs 22.57 MB (3.6x,
budget 1.1x OVER); rescope growth 1.127 vs control 1.180 (within). Since Mb4
the pool gained lazy residency (cold rows stay out of tables), maintained
grouping (POD-4686) and the read-state lane — STEP 1 re-measures at the
current tip before attributing anything.

Setup: timing checkout ~/podium-timing-4575 on flatblock at 6eda2826e
(integration tip), .toolchain bun 1.4.2 reused from podium-timing-4572,
harness/web/dist built there. Matrix: --arms noop,control,mobx --scales 1
--rounds 4 --samples 5 --scenarios coldBootstrap,principalSwitch,rescope
--host flatblock --remote-dir podium-timing-4575 (tag mc3-life), same shape
as Mb4's mb4-life for direct comparison. entries.test.ts green at SHA.

Open: bench:flatblock held by coordinator session with POD-4694 queued;
mailed POD-4286 for MobX-first ordering per the addendum.

### Mc3 matrix launch

- Coordinator reply: MobX goes first; its verification suite holds
  bench:flatblock (~2 h from 13:20 UTC). Matrix launched in background with
  per-invocation `--wait` acquires (tag mc3-life, same shape as Mb4 mb4-life);
  queue position #1 held by this session. 4694 re-queues behind.
- Process hygiene: a background matrix launched in a tool call that then
  blocks (sleep/tail/status) dies with the call's process group. Launch with
  `setsid nohup ... &` in a fast-returning call. First-paint outside-counts
  running locally in background the same way.
- Attribution in hand: bootstrap spy counts at 6eda2826e (lazy 212,855
  observables at 1x, 73.2% IssueNode = one node + 4 firing reactions per
  KNOWN issue at every `replace`, cold ones included).

### Mc3 15:45 UTC: still queued

Coordinator suite overrunning (~85 min past the ~2 h estimate); queue
position #1 held, flatblock quiet (load ~2.2). Matrix + first-paint both
alive and waiting. Audit §6/§7 re-read: G6 is this issue's gate; the audit
already names the mechanism ("every issue is instantiated at bootstrap,
including ~2,600 closed ones") with Linear's fix direction (observability on
first access).

### Mc3 STEP 2 decision framework (written before §1 lands)

Expected STEP 1 (Mb4 + unchanged construction path): bootstrap/switch/heap
still OVER, rescope growth within, no survivors (the run fails on survivors
by itself). Fixes in scope are LEAKS (listeners surviving dispose, models
retained by closures, registry not cleared on replace): dispose already stops
every node reaction before clearing (`visible.clear`), the arm unsubscribes
both channels, entrylib drops the old boot — review finds no retained path,
so STEP 2 most likely changes no code.

NOT in Mc3 scope: lazy issue nodes. The per-node visible/nested/formal/layout
reactions ARE the maintained visible set (no whole-table walk exists to
replace them); building nodes for visible rows only requires a detector that
evaluates visibility without nodes — a redesign touching every fence/count
lane other lanes own. If §1 misses, Mc3 reports construction as the mechanism
(one IssueNode + 4 firing reactions per known issue at every `replace`, cold
included: 155,744 spy-adds, 73% of bootstrap observables) with the
outside-counts as evidence, and it counts as a G6 gate result. No budget
widened.

### Mc3 STEP 2 baselines (local counts, load-independent)

- `pool.test.tsx` + `counts.test.tsx`: 14/14 green at a3e1b5328 (incl. the
  global `pendingReactions` zero check after pool tests). Re-run after any
  STEP 2 code touch.
- First-paint outside-counts green 2/2 (in the measurement doc).

### Handoff to POD-4705 (MobX lazy visibility nodes)

Mc3's mechanism (this issue): at every `replace`, `MobxPool.syncWorklist`
calls `VisibleCollection.sync(knownIssueIds)` (`pool/pool.ts:735`,
`pool/worklist/visible.ts:1287`), which builds one `IssueNode` (32 computed
annotations) plus four `fireImmediately` reactions (visible, nested, formal,
layout) per KNOWN issue — 4,867 nodes + ~19.5k reactions at 1x for 732
visible rows, cold rows included. Measured: 155,744 IssueNode spy-adds of
212,855 bootstrap observables; 4,867 visibility reactions walked from MobX's
own graph; bootstrap buildMs 640.6 vs control 109.0; retained heap 87.49 vs
22.54 MB.

Why lazy nodes need a non-walking visibility detector: the four per-node
reactions ARE the maintained visible set (`ids`), the nest/formal filings
(`nestedBy`, `childrenBy`) and the layout filings — there is no other path
by which an invisible row becoming visible is detected. Building nodes for
visible rows only removes the detectors for the invisible ones; replacing
them with one collection-level reaction (or a replace-time evaluation) must
read every row's visibility inputs, i.e. reintroduce the whole-table walk
the lint fence (`fence.json`, `no-table-walk`) and the reads fence refuse.
Sessions show the lazy shape works where something else already detects the
need (`session(id)` builds on first access; the visibility read that reaches
a cold session queues its load). The experiment: find what detects an
invisible issue's visibility transition without per-row reactions and
without a corpus walk, or prove no such detector exists in the MobX idiom.
Relevant: `visible.ts:1227 order` (reads every visible id's cached rank),
`visible.ts:1235 issue(id)`, `pool.ts:765 snapshot()`, `enumerate.ts`
`knownIssueIds` (the one sanctioned whole-membership walk).
