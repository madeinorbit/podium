# arms/hand — notes

## Round three: residency, a3 (POD-4580) · 2026-09-23

Cold rows (closed issues and their sessions) stay out of the pool until
something reads them (`pool/residency.ts`; schema doc §5, audit §7). Built
after the MobX build (Ma3, POD-4567; Ma4, POD-4568) and to its contract:
the same rule, transitions, window and shared seams (`RowSource.row`,
`RowView.loading`). Read with `pool/residency.test.tsx` and the README's
"Residency".

### Decisions

- **The rule is the schema's, applied by one shared function**
  (`coldByRule` / `viaTargetOf`, now in `shared/src/schema.ts` with a test in
  `schema.test.ts`): an issue is cold when `closedAt != null`; a session when
  its RAW `issueId` names a known issue cold by rule (a headless session of a
  closed issue too). The pool, the rebuild and the gate's partition check
  call it. The MobX arm keeps its own copy (`arms/mobx/pool/residency.ts`);
  it can switch when it next changes (as with `prefixCandidates` at Ha2).
- **Cold means not in the tables**: no slot, no cell, no record. A plain
  registry keeps the id (and a session's issue, so a reopen finds its
  sessions). The relation engine links cold rows like any other; its maps
  were plain already, so there is NO second (plain/observable) copy to
  promote, unlike MobX's twins. Buckets hold hot and cold ids alike.
- **Tracked the hand way.** "Is this row cold" is read by cells through a
  door (`ViewInputs.loading`, `HandPool.resident`, `lazyMany`, and `one()`'s
  presence): the door records the cell under `entity:id` in a `coldness`
  `DepIndex`. The registry reports each entry that appears or leaves; the
  pool turns it into a `residency` delta, a new member of the closed `Delta`
  union handled in every switch, which dirties exactly the cells that asked.
  No list of dependents is kept by hand.
- **First access = a cell reading through a lazy relation.** `loading(entity,
  id)` answers true for a known cold row and queues it; the first request
  arms a 50 ms window (`LOAD_WINDOW_MS`); every row queued inside it is read
  by id through `RowSource.row` (fenced: one read of that row) and installed
  in ONE commit (`HandPool.hydrate`). Duplicates coalesce. The load is
  deferred because a cell must not write the tables mid-drain.
- **A cold row's update that keeps it cold is relinked, not stored** (the
  brief's choice, and Ma3's): the kernel holds the value; a later load reads
  the current one. The engine gets `changed(entity, id, undefined, value)`:
  with no previous value held it re-resolves every link of the row (a link
  that did not move writes nothing) and re-decides the row's collapse group,
  reading cold PEERS back by id (finding 3). An update that makes the row
  itself hot (a reopen) installs it at once with its cold sessions
  (`warmDependents`, same commit, never painted loading); removing an issue
  warms its cold sessions. Only a `replace` makes rows cold again: it
  re-partitions (resident rows stay, the rest follow the rule over the new
  slice). An issue closed while resident stays resident.
- **`one()` answers a KNOWN target** (resident or cold): the pool's
  `present` option is "tracked presence, or known cold". A view that needs
  the target's DATA reads residency itself: the origin is now `originRef`
  (the engine's answer) → `originId` (resident only) → `originTick`, plus a
  `loading` part (origin or any member session cold). `buildRowView` sets
  `loading: true` only then; `sliceRowOf` drops it. `activityAt` and a
  draft's title read only resident sessions, so they are provisional exactly
  while `loading` is set.
- **Lazy collections: `HandPool.lazyMany(from, id, relation)` →
  `{ ready, pending }`** (criterion 3 at the relation level, as Ma3's): the
  resident members, and the count still cold, each of which is queued. A
  roll-up derives from `ready` and shows pending while `pending > 0`; Hb3
  builds the real progress roll-up on it. Tested with a progress cell over
  the live corpus (below).
- **`snapshot()` settles** (reads every resident row, loads what they
  queued, reads again; at most 64 rounds) and lists RESIDENT issues. The
  rebuild takes the pool's resident ids as an input (which cold rows were
  looked at is history, like the selection): its rows are the issues hot by
  rule plus the resident ones; the gate's checkpoint calls it without.
- **The arm refuses a feed without `row()`**; `new HandPool(...)` without the
  `lazy` option still holds every row (the Ha1/Ha2 relation tests).
- **Engine change (small):** the collapse decision skips a cold peer whose
  by-id read finds nothing (the kernel removed it ahead of its event); its
  own removal re-decides the group later in the same event.

### Findings

1. **Residency saves this pool table slots and cells, not bootstrap
   entries.** The hand pool builds no per-row object at bootstrap in either
   mode (cells and records are born on first read since Ha1), and a cold
   row's registry entry replaces its table slot one for one, so the entries
   a bootstrap builds are EQUAL: 57,125 at 1x, 228,657 at 4x, of which the
   relation index (ids only, plain, the same whatever the residency) is
   47,478 / 190,093. The saving shows at first read: the a1 list's first
   paint builds 23,827 cells lazy vs 53,538 with every row resident at 1x
   (-55%), 95,305 vs 214,149 at 4x. MobX's "15,547 observables vs 29,636"
   counts a different thing (observable map slots; its cold rows' relation
   entries are plain twins it does not count), so the two numbers are not
   comparable; the nearest like-for-like figure is issue + session table
   slots: 3,651 here (live-shaped fixture) against MobX's 4,202 at Ma3 (old
   fixture, so not the same corpus either).
2. **The lazy bootstrap is not faster here** (walls below): +15% at 1x,
   +6% at 4x, both flatblock runs. Probed and ruled out on flatblock (not
   landed): skipping the `residency` deltas no cell has asked about changed
   nothing measurable (1x 49.5 vs 43.3, 4x 248.0 vs 214.4). Cause not
   isolated; the remaining per-cold-row work is the rule itself, a registry
   and dependents write, and the engine re-deciding collapse groups with
   cold peers read back by id.
3. **A cold row in a resume-twin group reads its cold peers on every update**
   (no previous value is held, so the collapse group is re-decided): a new
   cold session sharing a resume ref with a cold twin read that twin by id
   (asserted in `residency.test.tsx`; nothing becomes resident). A plain cold
   heartbeat with no twin reads nothing but its own row.
4. **#1's commit fence is asserted again** (`counts.test.tsx`): the
   heartbeat's closed root and its session are cold, so the heartbeat is a
   registry write and the list never drew the row: 0 rows drawn, 2 reads —
   the MobX a-phase numbers exactly. The native lane asserts the same
   (`harness/native/hand-pool.native.test.tsx`: nothing redrawn).
5. **#8b's grace rows are visible yet cold** (Ma3 finding 4, seen here too):
   three of the six rows the tick folds (`i1545`, `i23`, `i4535`) are closed
   issues inside the 24 h grace window, cold by the schema's rule, so the a1
   list (resident rows only) does not draw them. #8b's commit cell is written,
   not asserted, and every changed row it did not draw is asserted cold. Hb1's
   visible collection must load them on first paint.
6. **The mount queues 617 loads at 1x** (2,399 at 4x): open spin-offs of
   closed origins on the live-shaped fixture. The a1 list then DRAWS those
   origins (it lists every resident issue) and they ask for their own cold
   sessions: a cascade of load windows that Hb1's visible collection ends.
   The counts test and the native test settle them before counting.
7. **Ma4's seed-8 shape has no counterpart here**: buckets are keyed by the
   reference and never placed by residency, so there is no second place to
   go stale. The sequence (evict a parent, move a child away, re-add the
   parent) is a test in `residency.test.tsx` anyway.
8. **The checkpoint's plant is different from MobX's** because the hand pool
   has no relation twins to promote: a SESSION loaded on access is installed
   but keeps its cold-registry entry (a promotion done by half). The per-step
   rebuild cannot see it (the row's data is resident; the stray `loading`
   flag is not a slice field); the checkpoint's "no row left cold" does.
   **The first plant could not fire on every seed**: "a cold session's update
   forgotten" passed seed 5 of the first 20 x 300 run (at b86e1f547), whose
   last arm (the checkpoint only sees the arm alive at the last step) saw no
   cold session update. Seeds 1-4 caught it at the checkpoint and the POOL
   passed seeds 1-5 on that run; the run was stopped and the plant replaced
   by one that fires on every seed (session loads happen in every arm), then
   the gate re-run from seed 1 (below). On the 2 x 60 shake-out the other
   plants failed where expected: removal-deaf by the rebuild (steps 15, 32),
   relink-skipped by the scan (14, 0), cold-deaf by partition or scan (9,
   20), cold-relink by the per-step scan (24, 20).
9. **The new `loading` part is one more reader of `issue.sessions`**: a
   session joining an issue now re-runs `activityAt`, `loading` and `view`
   (3 cells, was 2; `relations.test.ts` updated). #2's trap (Ma4: `activityAt`
   re-reading every member ROW on any member's change) is still present here
   and is Ha4's; the `loading` part reads residency and the bucket, never a
   row.

### Measured

Box: counts need none; walls on flatblock under `bench:flatblock`, 15 rounds,
arms interleaved with the order rotated, 1-minute load recorded per sample
(max 6.17, 4.53: both runs pass the load-8 rule), commit b86e1f547.

Bootstrap in the count harness (`pool/bootstrap.test.ts`, replay feed,
live-shaped fixture; `hand-pool-bootstrap-counts.json`):

| Scale | Pool | Issues resident / cold | Sessions resident / cold | Table slots | Relation entries | Cells / records | First-read cells |
|---|---|---|---|---|---|---|---|
| 1x | lazy (Ha3) | 2,166 / 2,701 | 1,485 / 2,819 | **4,126** | 47,478 | 1 / 0 | **23,827** |
| 1x | every row resident (Ha2) | 4,867 / 0 | 4,304 / 0 | 9,646 | 47,478 | 1 / 0 | 53,538 |
| 4x | lazy (Ha3) | 8,664 / 10,804 | 6,219 / 10,997 | **16,762** | 190,093 | 1 / 0 | **95,305** |
| 4x | every row resident (Ha2) | 19,468 / 0 | 17,216 / 0 | 38,563 | 190,093 | 1 / 0 | 214,149 |

Table slots -57% (1x) and -57% (4x). "Cells 1" is the id list, not yet run.
First-read cells: every listed row's view read once (the a1 list's first
paint), before any load lands.

Bootstrap walls, `create()` to a bootstrapped pool, reads fence off
(`POD_POOL_BOOT_WALLS=1`, flatblock, two runs; p50 / p90 ms):

| Scale | lazy (run 1) | all resident (run 1) | lazy (run 2) | all resident (run 2) |
|---|---|---|---|---|
| 1x | 49.1 / 64.6 | 43.9 / 58.8 | 49.5 / 56.3 | 41.4 / 46.1 |
| 4x | 253.3 / 618.3 | 234.3 / 622.5 | 247.6 / 359.1 | 232.1 / 337.6 |

Browser bootstrap wall: NOT MEASURED; it waits for L5e (POD-4561, still in
backlog on 2026-09-23).

Row views on first read (`residency.test.tsx`, list mounted, 1x): 2,166
rows drawn, 2,166 `IssueCells` (one per drawn row, none for a cold one),
23,827 cells created (every one belongs to a drawn row, plus the id list),
0 records.

Loader (`residency.test.tsx`): two rows asked for inside one window → one
timer at 50 ms, one `row()` read each, one commit, both resident; the reader
saw `loading:-` then the row, never an empty one; a hydration is one fenced
read (`rows: 1`, `issue: 1`); the real timer closes the window on its own.

Lazy relation (`residency.test.tsx`): a hot parent with hot and cold
children, a progress cell over `lazyMany`: `{ done 0, total <hot>, pending
<cold> }` until the window closes, then `{ done <cold>, total <all>,
pending 0 }` (closed children count as done once loaded).

Fence steps (`counts.test.tsx`, 1x engine, live-shaped fixture, loads
settled before counting):

| step | oracle changed | drawn | commit fence | reads / budget |
| --- | --- | --- | --- | --- |
| #1 heartbeat | — | — | asserted | 2 / 3 (session, worktree) |
| #3 click | i214 | i214 | asserted | 1 / 3 |
| #4 rename | i214 | i214 | Hb1 (unchanged ruling) | 1 / 3 |
| #8 tick | — | — | asserted | 0 / 0 |
| #8b grace | 6 rows | the 3 resident ones | missed rows asserted cold | 3 / 144 |

GATE_OF_RECORD_PLACEHOLDER

### Open

- Browser bootstrap wall: L5e (POD-4561).
- Hb1: the closed fold lists ids from metadata and loads rows only when
  drawn; the grace rows of finding 5 load on first paint.
- Hb3: progress from `lazyMany(...).ready`, `loading` while pending.
- Ha4: #2's per-member re-read (Ma4's lesson) is still in `activityAt`.

## Round three: relations, a2 (POD-4579) · 2026-09-23

The relation engine (`pool/relations.ts`), maintained from the declared
schema. Read with `pool/relations.test.ts` and the README's "Relations from
the schema".

### Decisions

- **Buckets are `Set`s edited one member at a time, not frozen arrays.** The
  brief's idiom says "Maps of readonly id arrays"; M3 (POD-4591) failed the
  MobX pool for exactly that shape (F1: a copy and sort per membership
  change, 4,575 elements per new issue on the live export). A `Set` is O(1)
  per edge and has no order to maintain. The cost moves to readers that need
  an order; today that is one: a draft's first member, now the LOWEST
  session id (`views.ts` `firstMemberOf`), which is also what the MobX
  pool's sorted buckets give. Legacy uses replica order, which no pool has.
- **`indexUpdates` counts ELEMENTS, not slots** (bucket members, forward
  entries, path-index entries, collapse entries): F1's counting half.
  `relations.test.ts` "upkeep does not grow with the bucket" asserts a new
  issue costs the same elements, reads and bucket object in a repo of 1,000
  as in a repo of 1.
- **Relation reads are tracked per SLOT.** The engine records each slot it
  writes (`issue.children:I1`, `issue.parent:I2`); the pool turns each into
  a `relation` delta (a new member of the closed `Delta` union, handled in
  every switch) that dirties the cells that read that slot, and nothing
  else. `one()` tracks the target's PRESENCE (a new `presence` index,
  invalidated only on membership deltas), not its row, so a target's field
  change re-runs only parts that read its fields. `tracked.has` moved to the
  presence index too: a `has` answer changes only with membership.
- **F2 applied: row views resolve nothing.** `repoId` and `originId` are
  `relations.one(...)`; `repoRef`/`originRef` (own-row foreign keys) are
  gone, and `relationRef` is no longer imported by `views.ts`. A rename
  moves no relation slot, so neither part re-runs.
- **Repo takeover reads `repo.worktrees`** (`tables.ts` `releaseRepo`);
  `otherLaneOf`'s table walk is deleted. The engine runs inside `put`/`drop`,
  so the leaving lane has already left the bucket when the takeover asks.
  A `replace`'s staging tables keep no relations, so `reseed` stages each
  record once (last value wins) and a staged lane can never hand a repo over;
  `releaseRepo` throws if one tries.
- **The prefix candidate walk is shared** (`shared/src/schema.ts`
  `prefixAncestors`, `prefixCandidates`, beside `longestPrefixPath`), with a
  test that probing the candidates finds what `longestPrefixPath` picks. The
  MobX engine carries its own copy (`ancestorPaths`, `prefixCandidates`);
  it can switch to the shared one when it next changes.
- **Collapse shortcut:** a row that keeps its group whole before and after
  (a live session's heartbeat) decides nothing and reads no twin; a group of
  one decides without reading a row.
- **The scan oracle** (`enumerate.ts` `scanRelations`/`diffRelations`) is
  written for this arm, not imported from the MobX arm (the import fence):
  it walks the tables, groups the collapse, and resolves prefixes with
  `longestPrefixPath`, sharing only the declared resolvers and `relationRef`
  with the engine. Collections compare as sorted sets.

### Findings

1. **#1's commit fence can no longer be met by the a1 list.** Its session is
   bound to a closed agent root the worklist never shows; with
   `issue.sessions` maintained, the heartbeat really moves that row's
   `activityAt`, and the a1 list draws every issue, so it redraws `i1211`.
   Same class as #4's `i933` at a1; moved to Hb1 in `counts.test.tsx`, which
   now asserts instead that every extra drawn row is one the oracle hides.
   The reads budget is unchanged and still asserted.
2. **A draft's title read the member bucket on EVERY issue** (the member was
   an eager argument), so any session joining an issue re-ran its title
   cell. `displayTitleOf` now takes a thunk: a non-draft reads no relation
   (asserted: a session joining I2 re-runs exactly `activityAt:I2` and
   `view:I2`).
3. **Mutation check** (`relations.test.ts`, 45 tests, each mutant run alone
   against the committed engine, file restored with `cp`): `where` fields not
   treated as link inputs → 13 fail; a new root takes no sessions → 30; a
   removed root re-homes none → 12; the collapse shortcut on the new row's
   state only → 6; `one()` ignoring presence → 21; collapse flips not
   relinked → 10. None survived.
4. **The engine's own element count cannot see a copy-and-sort.** F1's plant
   (every membership change replaces the touched buckets with a sorted copy,
   the MobX shape) still reports 2 elements per add and per remove through
   `indexUpdates`, because the copy bypasses the counted path. The F1 test
   therefore counts with an instrument the engine cannot under-report to:
   every `Set` add/delete/iterator step and every element handed to
   `Array.prototype.sort`, process-wide, for the one ingest. Honest engine:
   8 ops per add and per remove at b = 4,000 AND at b = 8,000. Plant: 12,012 /
   12,009 at 4,000 and 24,012 / 24,009 at 8,000. Any review of bucket upkeep
   should count this way, not trust the arm's own counter.
5. **Listener-level relation tests (Ha1's item 4).** A mounted row hears:
   a session joining and leaving its issue, and evict then re-add of the
   session and of the issue (`relations.test.ts`, "a relation write dirties
   only..."); its origin evicted, re-added and renamed (`pool.test.tsx`,
   "re-seats a spin-off..."); its repo's prefix changing and its repo
   leaving (`relations.test.ts`, "a mounted row hears its repo's prefix
   change..."); its repo's lane handover (`pool.test.tsx`). Child
   added/removed has NO listener test because no a2 view reads
   `issue.children`; the worklist phase (Hb1-Hb3) owns it, and its listener
   test belongs with the first cell that reads the bucket.

### Measured (OLD FIXTURE 1x and hand-built rows, counts only; no walls)

Relation write record per change kind (`relations.test.ts`, hand-built
9-row graph, fence on; `hand-pool-relation-writes.json`). Slots are exact
(asserted); elements are `indexUpdates`; rows are the fence's distinct reads
for the whole ingest.

| change | slots | elements | rows read |
| --- | --- | --- | --- |
| heartbeat | 0 | 0 | 1 |
| rename | 0 | 0 | 1 |
| new issue | 2 | 2 | 1 |
| reparent | 3 | 4 | 1 |
| archive (`where` input) | 2 | 2 | 1 |
| session moves issue | 3 | 4 | 1 |
| session moves lane (cwd) | 3 | 12 | 2 |
| deps change | 3 | 4 | 1 |
| new session | 4 | 7 | 2 |
| remove session | 4 | 9 | 1 |
| new lane | 2 | 2 | 2 |
| new lane over a session | 5 | 6 | 2 |
| remove lane (2 sessions re-homed) | 6 | 10 | 3 |
| evict a parent | 2 | 2 | 1 |

The lane moves' extra elements are the path index (one entry per ancestor
of the old and new cwd). Upkeep vs bucket size: one new issue in a repo of
1,000 = one in a repo of 1 (2 elements, 1 row, same `Set` object; asserted).

**F1 bound: O(1) per edge, independent of the bucket size b** (`relations.test.ts`,
"bucket upkeep is O(1) in the bucket (M3 F1)"; `hand-pool-bucket-upkeep.json`,
`hand-pool-bucket-upkeep-plant.json`):

| b | add: elements / ops | remove: elements / ops |
| --- | --- | --- |
| 4,000 | 2 / 8 | 2 / 8 |
| 8,000 | 2 / 8 | 2 / 8 |
| 4,000, copy-and-sort plant | 2 / 12,012 | 2 / 12,009 |
| 8,000, copy-and-sort plant | 2 / 24,012 | 2 / 24,009 |

Asserted: the 4,000 and 8,000 rows are equal, elements ≤ 4, ops < 100; the
plant's ops exceed b and grow with it.

**F2 plant** (`relations.test.ts`, "row views resolve single-valued
relations through the engine (M3 F2)"): a wrong forward entry planted for
`issue.repo` and `issue.discoveredFrom` is exactly what the row view shows
(`OTH-1` for `POD-1`; the origin tick names I3, not I1), and `diffRelations`
names both slots. A view that re-resolved from its own row would still show
the truth, so the test fails if the views stop reading through `one()`.

Fence steps (`counts.test.tsx`, 1x engine, OLD FIXTURE, shared budgets):

| step | oracle changed | drawn | commit fence | reads / budget |
| --- | --- | --- | --- | --- |
| #1 heartbeat | — | i1211 (hidden) | Hb1; extra row asserted hidden | 1 / 3 |
| #3 click | i17 | i17 | asserted | 1 / 3 |
| #4 rename | i17 | i17, i933 (hidden) | Hb1; extra row asserted hidden | 1 / 3 |
| #8 tick | — | — | asserted | 0 / 0 |
| #8b grace | i300-i303 | i300-i303 | asserted | 4 / 96 |

**Gate of record (L4b, rebuild-only, OLD FIXTURE 1x), 2026-09-23: GREEN.**
Seeds 1-5 × 200 steps, every change kind (optimistic kinds included and
green), `gate.test.ts` "correctness gate", run in foreground chunks
(`POD_POOL_GATE_FIRST_SEED`, seed 1 / 2-3 / 4-5; an unchunked 5-seed run
also passed, 681 s, its record overwritten by the first chunk). 1,005
rebuild comparisons, and 1,005 per-step scans of EVERY relation of every row
against `diffRelations` (201 per seed). Both plants fail every seed:

| seed | rebuild checks | relation scans | arm creations | removal-deaf plant fails at | relink-skipped plant fails at |
| --- | --- | --- | --- | --- | --- |
| 1 | 201 | 201 | 5 | step 15 | step 62 |
| 2 | 201 | 201 | 7 | step 37 | step 25 |
| 3 | 201 | 201 | 2 | step 7 | step 3 |
| 4 | 201 | 201 | 4 | step 3 | step 44 |
| 5 | 201 | 201 | 3 | step 1 | step 1 |

The removal-deaf steps are Ha1's (same sequences). Round-two bug shapes on
these sequences: `evictThenReAdd` 30, `offerRemovedOnFinishedChild` 49,
`clockDecay` 46, `twoRankMovesInOneBatch` 19, `rankMoveWithinGroup` 10.
Box load 8-14 during the runs: counts and pass/fail only, no walls.

### Open

- The fidelity test still skips a draft's title where it needs a member:
  legacy's "first member" is replica order.
- `activityAt` reads explicit sessions only; containment-owned sessions
  (`issue.worktree` → `worktree.sessions`, R3) join in the worklist phase.

## Round three: the pool, a1 (POD-4578) · 2026-09-23

Decisions, findings and open questions for `pool/`. The idiom, write path,
stats and "how to add a field" are in `README.md`. Built after the MobX
pool (Ma1-Ma4) by operator decision; its lessons came in the brief (the M4
document, POD-4597, is not written yet).

### Decisions

- **Placement (coordinator ruling on Ma1, symmetric).** The pool lives in
  `arms/hand/pool/`; the round-two files stay frozen until the pool's
  worklist replaces them. The lint thaws `hand/pool`, so every fence rule
  runs on it against `arms/hand/fence.json`, plus the import fence (nothing
  in `pool/` imports anything under `arms/` outside `pool/`), proven red on
  planted files in `harness/lint/fence-lint.test.ts` (round two's
  `indexes.ts`, `store.ts`, `arm.ts`, `rollup.ts` and the MobX pool). The
  roster names `hand` pending until POD-4581 (Ha4).
- **Dependencies are recorded, not listed.** The hand-rolled answer to "no
  sensitivity sets": every derived value is a `Cell` whose reads go through
  tracked doors, and each door records the running cell under its key
  (`cells.ts` `DepIndex`). The delta handlers name no derived value: a row
  delta dirties the readers of `entity:id`, a membership delta the readers
  of the table's id list, a click the readers of the two selection keys, a
  tick the readers of the deadlines it crosses. The cost is a reverse index
  entry per (cell, key read) and one unlink/relink per re-run; the gain is
  that a derived value cannot forget an input it reads, which is the round-
  two bug class (the clock reaching the roll-up but `ClockChanged` a no-op).
  This is the core of the arm and the first thing H3 (POD-4598) should
  review.
- **One commit per event, handlers in topological order** over a closed
  `Delta` union with a never-check in each: `invalidate` → `release` →
  `flush` → `publish`. A replace is one event: observers see one transition
  (`pool.test.tsx`, "replaces atomically").
- **Cells are born on first read and kept current by every drain after.**
  Nothing is ever dirty outside a drain except a cell that has never run,
  so a pull outside a commit (a render, `snapshot()`) never sees a stale
  value. The price: a cell created once (every issue, when the a1 list or
  the checker's `snapshot()` reads it) is re-run on its inputs' changes
  until its row leaves or the pool is disposed. Releasing off-screen rows'
  cells is the windowed list's (Hb2) to decide.
- **Every part of a row view is its own cell; a relation is split into
  reference and resolution**, as the MobX build found (Ma1: 9 → 5 → 1 rows
  read on #4). Taken over, not re-measured by bisection.
- **One-hop relations resolved from the own row plus the target's slot**
  (`relations.ts`), like Ma1: no bucket is maintained at a1, and a target's
  arrival, change or departure reaches its readers because they read its
  slot. `displayRef` and `originTick` are real values; collections and
  prefix answer "none" until Ha2.
- **The repo's row is a lane.** When the lane holding a repo leaves, another
  lane of the repo takes over (`enumerate.ts` `otherLaneOf`, a walk of the
  worktree table: tens of rows), found without relations; Ma1 dropped the
  repo with its holding lane and Ma2 fixed it with `repo.worktrees`. Ha2
  should switch to the maintained collection.
- **L4b rebuild-only at a1** (`oracleEvery: 0`, ruled acceptable). The
  gate's NO is the same pool planted deaf to removals.
- **Round-two `it.fails` tests stay** (7 files' worth, POD-4551): the pool
  does not replace the round-two code yet. They go with that code.

### Findings

1. **Evict then re-add left a mounted row blank (caught by `pool.test.tsx`,
   fixed).** Removing an issue disposes its cells; re-adding it dirtied no
   cell (none existed), so no listener heard, and a mounted slot kept
   showing nothing. The fix is in `release`: an issue delta that moves
   membership notifies the row's listeners, whichever direction. The L4b
   gate cannot see this class: `snapshot()` pulls fresh cells on every call,
   so the incremental snapshot and the rebuild agree while the mounted row
   is stale. Only a listener-level test (or the count harness on an evict +
   re-add step) sees it. H3's "evict then re-add re-seats relations" check
   should include a mounted row, not only the snapshot.
2. **The 1x fixture has one lane per repo** (Ma1 finding 3 from the other
   side): the repo takeover path never runs on the fixture; the test adds a
   second lane to exercise it.

### Measured (OLD FIXTURE 1x, counts only; no walls taken at a1)

Every count below is on the old 1x fixture, which is not live-shaped
(`docs/measurements/POD-4441-fixture-shape.md`, "Fixture vs live"): it
spreads issues over ~500 repos with one lane each, where the live export has
9 repos and one holds 88% of the issues. POD-4635 (L2d) reshapes it; these
numbers are provisional until re-measured there.

Gate of record so far, `POD_POOL_GATE_SEEDS=5` (seeds 1-5 × 200 steps,
every change kind, 1,005 rebuild comparisons, 2-7 arm creations per seed
from reloads), heavy lane, 2026-09-23: **green**; the removal-deaf plant
failed every seed, at steps 15, 37, 7, 3 and 1 (the same first removals Ma1
recorded on the same sequences). The sequences covered every round-two bug
shape: `evictThenReAdd` 30, `twoRankMovesInOneBatch` 19, `clockDecay` 46,
`offerRemovedOnFinishedChild` 49, `rankMoveWithinGroup` 10 — though at a1
no view reads what most of them move (members, children, order).

Fence steps (`counts.test.tsx`, 1x engine on the old fixture, shared budgets):

| step | oracle changed | drawn | commit fence | reads / budget | rows derived |
| --- | --- | --- | --- | --- | --- |
| #1 heartbeat | — | — | asserted | 1 / 3 (the ingest's slot read) | 0 |
| #3 click | i17 | i17 | asserted | 1 / 3 | 1 |
| #4 rename | i17 | i17, i933 | Hb1 (i933 is a hidden spin-off) | 1 / 3 | 2 |
| #8 tick | — | — | asserted | 0 / 0 | 0 |
| #8b grace | i300-i303 | i300-i303 | asserted | 4 / 96 | 4 |

Replay corpus tick (`pool.test.tsx`, old fixture): 30 deadlines waited on over 4,867
issues; the 24 h tick crossed 4, re-derived 4 views, changed 4 (12 cell
runs); a rewind restores them and the rebuild agrees both ways.

#4 read 2 until a drawn row's `view(id)` stopped asking the table for a
row whose cells already exist (the presence check is needed only on a
first read); now 1, the renamed row.

### Module map (a1, lines incl. comments)

`pool.ts` 476 · `views.ts` 349 · `cells.ts` 281 · `tables.ts` 179 ·
`clock.ts` 99 · `relations.ts` 97 · `records.ts` 91 · `arm.ts` 85 ·
`enumerate.ts` 73 · `rebuild.ts` 48 · lists and rows 113: **1,891**
non-test lines. Ma1's pool at its landing (`dd7fde922`): ~1,606 (no
`cells.ts`; MobX is the cell layer).

### Open (constraints for Ha2, from the MobX shape review)

M3 (POD-4591, `docs/decisions/pod-4545-round-three-shape-review.md`) sent
the MobX pool back on two lines that bear on the hand pool's next phase:

- **F2, resolution through the engine.** The a1 parts resolve `issue.repo`
  and `issue.discoveredFrom` with `relationRef` plus a target read (as Ma1
  did; at a1 `PoolRelations.one` is the same computation and the only
  path). Once Ha2 maintains a forward map, the parts must call
  `relations.one(...)`, which reads the forward slot and the target's
  presence, never the own row, so the rename split still holds; and
  `relationRef` stops being exported to `views.ts`.
- **F1, bucket upkeep sized by the change.** A collection must not be
  copied and sorted per membership change: on the live export `repo.issues`
  is 4,574 of 5,170 issues. Ha2's buckets must insert and remove per edge
  (a `Set`, or a binary-searched insert) and count elements touched, not
  slots. The lint cannot see a bucket walk (it matches table names).
- **N5.** The repo-from-lane routing (`tables.ts`) is feed-shape
  composition that both pools hand-code; the review suggests it belongs in
  the shared feed or schema layer.

### Open

- Draft titles read the first member session in the rule; members are none
  until Ha2, so a draft shows "New agent" (as in Ma1).

## Round two (frozen)

# POD-4446 NOTES — hand-rolled arm, milestone 1
## Decisions

- **Buckets hold ids, not objects.** A content-only session change moves no
  bucket, so the unrelated heartbeat costs zero index writes, zero
  derivations, zero commits. Objects are borrowed by reference from the
  stream and never spread on the hot path.
- **Archived sessions sit in membership buckets, filtered at read.**
  `membersOf` excludes archived + shells + headless (the legacy ownership
  read); the unread rollup reads explicit seats minus shells with archived
  included (the replica `indexSessionsByIssue` rule). One seat system, two
  reads — verified against the oracle (i49: archived member session,
  replica-derived unread keeps the finished row visible in its 7-day window).
- **Issue `unread` is derived, never trusted from the wire.**
  `derivedUnread` replays `deriveIssueRollups` exactly (readAt vs updatedAt
  vs member activity; deleted reads as read). The seed wires carry a static
  `unread: false` that disagrees with the replica derivation — trusting it
  failed parity on i49 at SMALL.
- **Subtree = visible formal subtree for attention, live formal subtree for
  progress.** Started-by provenance nesting is out (spec §6); the corpora
  carry no `startedBySession`, so formal-only matches legacy exactly here.
  Spin-off tip / vacated-origin / continuation machinery is still
  implemented (fixture + seeds carry `discovered-from` edges and it feeds
  rollup units + review-withdrawal), reading the maintained R4 adjacency —
  never a table scan.
- **Snapshot is the unselected baseline.** `snapshot()` always projects with
  `(null, false)` selection like the oracle; the closed-fold latch applies
  to rendered placement only (`setSelection` recomputes the two rows'
  lanes). Engine-driven selection is invisible by row-source design
  (locals-only publications emit no event), so the engine-backed click
  commits 0 rows; the UI click path commits exactly the two rows whose
  selected-ness flips, with 0 derivations (both evidenced in tests).
- **Agent-audience rows need a visible formal host.** The legacy nesting
  pass drops top-level agent rows ("internal issues: nested only"), and the
  oracle flattens what survives — so the flat slice drops agent rows with
  no visible formal ancestor (250 at 1x fixture: 211 rows, matching the
  control exactly). Walk passes through invisible intermediates; the
  started-by fallback is out (spec §6) and absent from the corpora.
  Rescued rows host in a second round (legacy nests after rescue).
- **Merge decisions and awaiting-merge never fire in the worklist.** Both
  read `branch`/`gitState`, which the navigation model never carries
  (`deriveIssueViews` drops them), so the legacy slice only ever decides
  `review`. The arm matches legacy (spec: legacy wins over shorthand) —
  reading the richer wire would fail parity. Same for `dependents`, which
  the arm re-derives from outgoing edges like the model does.
- **`closed` is the fold predicate, not the lane.** Pinned settled rows
  read `closed: true` while rendering in PINNED (the oracle projects
  `rowInClosedFold` directly).
- **Notifications count batches.** `notifications` = dispatch passes (one
  batch = one pass), including no-op passes — the heartbeat records
  `notifications: 1` with zero commits and zero derivations.
- **`rollupsDerived` counts every derivation body execution** (own-summary,
  subtree-aggregate, visibility-predicate). `rowsDerived` counts committed
  rows (new + changed + removed). `indexUpdates` counts mutating bucket
  writes. Bootstrap counts are reset after construction.
- **Native renders full in a ScrollView for M1** (same as the control lane,
  so counts compare directly); the web list is genuinely windowed.
  FlatList recycling is named M3 hardening (open question below).
- **No `@tanstack/react-virtual`.** Windowing is ~40 lines hand-rolled;
  a new dependency for that would cost more than it saves and risk the
  native-incompatible budget.

## Count tables

### 1x engine-backed (GROWTH_CORPORA.x1; 4,867 issues / 4,304 sessions / 500 repos; 3,332 visible rows; `hand-1x-counts.json`)

| Scenario | Rows committed | rowsDerived | rollupsDerived | indexUpdates | notifications | Parity |
|---|---|---|---|---|---|---|
| #1 unrelatedHeartbeat | 0 / 3332 | 0 | 0 | 0 | 1 | green |
| #2 visibleSessionPhaseChange | 1 (i0) | 1 | 3 | 0 | 1 | green |
| #3 selectionClick (engine path) | 0 | 0 | 3¹ | 0 | 1 | green |

¹ The eager mark-read row: readAt moves no summary/visibility/aggregate
value, but the three input checks proving that execute. Zero value changes.

### UI click path (happy-dom, `hand.ui.test.tsx`)

| Action | Rows committed | rowsDerived | rollupsDerived |
|---|---|---|---|
| setSelection A→B | 2 (A, B) | 0 | 0 |
| Phase change on B (chain A+B) | 2 (A, B) | 2 | chain |

### SMALL engine-backed

Identical shape: heartbeat 0/37 all-zero, phase 1 row (i0) + chain of 1,
click 0 rows + 3 evaluations, parity green throughout, rebuild oracle green
after every scenario.

### G2 fixture at 1x (engine-booted, `hand.fixture.test.ts`)

211 visible rows — exactly the control's set. Full-snapshot deep-equal with
`snapshotFromStore` (rows, order, groups) plus the rebuild oracle. This is
the corpus the browser pages measure; the scenario corpora above exercise
the change paths, this one exercises the rule surface (nesting drops,
decay windows, closed fold, defer bands, pinned lanes).

### Browser (1x click input-to-paint)

- Readiness + parity in Chromium (no timing): hand page boots at 1x
  fixture, `snapshotHash` **matches the control exactly** (`6365b567`,
  211 rows), 17/211 rows mounted (windowing verified: 1000px viewport,
  18kpx scroll height).
- Wall timing: first attempt 01:31 at load 14.78 (refused — above 8);
  second window 02:05 at load 5.0 but the G4 driver's serve path 404d
  (fixed: `entries/` fallback in `run.ts`, committed); load then 9.15.
  p50/p95/max table lands when a quiet window holds — counts above are
  the verdict meanwhile.
- Driver note for other arms: `run.ts` `serveDist` did not match vite's
  `dist/entries/` layout (`/hand.html` 404d, page never ready). Fixed
  with an `entries/` fallback; control page unaffected.

## Line count (arm folder, `wc -l`; tests excluded)

3,237 total / 2,801 code-only vs the 800–1,500 budget — OVER, openly.
Breakdown (total): rules ~500, indexes ~480, rollup ~470, visible ~340,
store ~340, groups ~220, summary ~170, order ~150, react ~180, rows ~130,
rebuild ~90, deltas ~80, tables ~70, arm ~50, native ~70.

Where the weight is: faithful transcription of 8 legacy rules with decay
windows, continuation/vacated spin-off graph, rescue chains, closed-fold
grace, prefix containment, merge decisions (defensive wire reads) — plus
~250 lines of exhaustive-switch arms the brief's own definition mandates
(one per handler per kind). Compression applied: archived-in-bucket killed
a whole seat system; member lookup shared; store dispatch unified. Further
compression is comment-trimming, not structure — deferred to H4 review.

## Open questions for H4

1. Line budget vs fidelity: is 3,237 lines (2,801 code) acceptable for a
   parity-exact slice, or should M2 compress (and what may be dropped)?
2. Native windowing: ScrollView-full is fine at 211–3,230 rows in the unit
   renderer; does H4 want FlatList recycling with device evidence?
3. `rollupsDerived` semantics: currently every body execution (including
   vacuous input checks). Keep, or split classification from derivation?
4. Engine-driven selection is invisible to arms by row-source design — the
   #3 budget's "2 rows" only manifests on the UI click path. Confirm this
   reading for the MobX/TanStack arms before they build the wrong probe.
5. Defensive wire reads (`branch`, `gitState`, `name`, `busy`,
   `supersededBy`, `dependents`) are absent from `SliceIssue` but present
   on engine rows and required for parity (merge decisions, draft titles).
   Should the slice type grow them, or is defensive reading the idiom?

---

# POD-4450 NOTES — hand-rolled arm, milestone 2 (structural scenarios 4–10)

## Arm changes (each: did it add a place to remember?)

1. **`summary.rebuildAll` populates `timeSensitive` (the M2 gap).** No new
   place: the set already existed, the bootstrap just never filled it, so
   every tick after boot skipped deferUntil carriers and bands went stale
   past a defer boundary. Found because the 1x tick showed 45 re-evals
   (decay only) with zero summary refreshes. Regression test per
   sensitivity set in `hand.test.ts` ("clock sensitivity sets"); the band
   test fails without the fix.
2. **Order drops its clock sweep.** No new place: summary precedes order in
   topology order and every band flip arrives as `SummaryChanged`, so the
   `timeSensitive` re-rank loop (541 rows × O(visible) probes per tick at
   1x, zero moves) was pure waste. After: tick pays zero order probes.
3. **Order membership set + rank-key memo.** No new place: both live inside
   `order.ts` beside the array they mirror (members on insert/remove/
   rebuild; ranks compared by exactly the fields `compareRank` reads).
   Kills the R-H1 `includes`-per-dirty-row and all no-move re-ranks
   (burst50 paid ~1,100 wasted probes before).
4. **Issue prev-seat map (`issueSeats`).** No new place: the `sessionHome`
   precedent, same diff shape. Kills the `moveSeat` full-map scan per
   issue ingest (O(repos) buckets walked for every issue delta); `moveSeat`
   itself is deleted.
5. **R-H2/R-H3.** `rebuildRootsAfterIssue` (dead) removed;
   `store.tableApply`'s kind switch ends in `assertNever`, so a new stream
   kind is a compile error, not a silent drop.
6. **`scan(name, visits)` vocabulary in `deltas.ts`.** Extended place #1
   (README), not a new one: names the remaining multi-row walks so the M2
   run prices them per scenario. Counts are asserted exactly by the M2 run;
   the rebuild oracle does not cover counts (values only).
7. **Reverted before landing: seeding ancestor chains on
   `VisibilityChanged(false)`.** Tracing the exhibiting shape showed it is
   unreachable (a finished row with a pending decision is stage-review,
   hence `activeHuman`-kept, hence never decays; decay/rescue leavers carry
   no sessions and no pending decisions; archive/evict already seed via the
   edge change). It would have added a redundant compute to every
   visibility loss for zero scenario benefit. The adjacent real holes are
   findings F1–F2 below, not M2 fixes.

## Count tables (1x: 4,867 issues / 4,304 sessions; 3,332 visible rows)

POD-4496: the scenario seed dual-carries R3 anchors on wire + projection
(`scenarios.ts`; legacy reads projection, `issue-view-models.ts:88,171-173`,
projection overwrites wire). Before the dual-carry the oracle was blind to
R3 (3,230 rows); after, both sides resolve R3 (3,332 rows, +102 anchors
incl. i265). i6 is now visible via s6, so #9 optimism touches all three
bodies like the visible supplement.

BEFORE (no arm changes; parity + rebuild oracle green throughout):

| Scenario | Rows committed | rowsDerived | rollupsDerived | indexUpdates | notif |
|---|---|---|---|---|---|
| #4 rename | 1 (i0) | 1 | 3 | 0 | 1 |
| #5 stage move | 1 (i3) | 1 | 3 | 0 | 1 |
| #6a new | 0 (mount¹) | 1 | 3 | 2 | 1 |
| #6b archive | 1 (i3²) | 2 | 1 | 1 | 1 |
| #6c evict | 0 (unmount¹) | 1 | 0 | 1 | 1 |
| #7 reparent | 2 (i2, i8) | 2 | 5 | 2 | 1 |
| #8 tick | 0 | 0 | 45 | 0 | 1 |
| #9a press / #9b echo | 0 / 0 | 0 / 0 | 3 / 3 (was 2/2 pre-R3; i6 now visible) | 0 / 0 | 1 / 1 |
| #9c rejected press | 0 | 0 | 6 (was 4) | 0 | 2 |
| #9d rollback quiet | 0 | 0 | 0 | 0 | 0 |
| #10 burst50 | 21 | 32³ | 143 | 50 | 1 |

¹ Arrivals mount and departures unmount; mount-phase renders are excluded
by the RowShell by design, so the harness logs 0 — the work (order + one
row derivation) is in `rowsDerived` and the visible count (+1 / −1).
² The leaving row unmounts; its parent i3 (lost subtree member) commits.
³ 21 updates + 11 arrivals (visible 36→47): mounts explain the whole gap,
no double-commit (key-dedup would be the other mechanism; not observed).

AFTER (budgets beside each number; scans per step):

| Scenario | Rows committed | derivations | scans (visits) |
|---|---|---|---|
| #4 (1 row, 1 deriv) | 1 ✓ | 1 + 3 bodies⁴ | batch 11,162; snapshot 3,230 |
| #5 (affected + order) | 1 ✓ | 1 + 3 | walk 2+2; batch 11,162; snapshot 3,230 |
| #6a (order + row) | 0 mount ✓ | 1 + 3 | batch 11,165; groups 3,231; rowgrp 9; snapshot 3,231 |
| #6b (order + row) | 1 ✓ | 2 + 1 | batch 11,165; order-idx 3,229; groups 3,230; rowgrp 7; snapshot 3,230 |
| #6c (order + row) | 0 unmount ✓ | 1 + 0 | order-idx 3,228; groups 3,229; rowgrp 6; snapshot 3,229 |
| #7 (both chains) | 2 ✓ | 2 + 5 | walk 2; batch 11,162; snapshot 3,229 |
| #8 (band-movers only) | 0 ✓ | 0 + 558⁵ | snapshot 3,229 |
| #9 each step phase-like | 0 ✓ | 3/3/6/0 (POD-4496: i6 visible via R3) | snapshot only (no walks, no batch⁶) |
| #9 suppl. visible press | 0, identity kept ✓ | 3 | batch 11,162; snapshot 3,229 |
| #9 rollback identity | echo object ✓ | — | — |
| #10 (one event, ≤50+chains) | 21 ✓ | 32 + 143 | walk 3+24; batch 11,268; groups 3,240; rowgrp 83; snapshot 3,240 |

⁴ Derivation bodies are arm-relative (methodology Q-H3/M3): own-summary +
visibility + aggregate = 3 per single-row change. Cross-arm metric is rows
committed. ⁵ 513 live deferUntil carriers + 45 decay rows; every number
reconciles (27 archived carriers excluded before counting). ⁶ POD-4496: i6
is VISIBLE at 1x (R3 anchor s6 joins i6 after the projection dual-carry),
so optimism steps touch all three bodies like the visible supplement (3
evals per press, 6 for the double press). Pre-R3 it was invisible
(unbound session, no audience), touching summary + visibility only.
mechanism: `readAt` feeds no derived value, and the kernel restores the
echo object by reference on rollback (G3 covered truth). The visible-row
supplement (#9 suppl., i0, all three bodies) carries the non-vacuous half.

Scan judgments (H4's handed-down slope question — inherent or removable):

- `rollup-batch` ~11.2k per computing dispatch (2× session seats +
  staffed ancestor steps): REMOVABLE via incremental open/lastActive/
  staffed seats; kept as one-build-per-dispatch for M2. The biggest slope
  item — J-phase.
- `groups-rebuild` ~V per affecting batch: INHERENT to rebuilding group
  sequence from the global order (contents already scoped to touched
  groups). J-phase slope item.
- `order-index` now only on removals (~V per removal): INHERENT to
  array-order maintenance short of a maintained index map (priced,
  deferred).
- `rows-group` (touched-group members), `visible-walk`/`rollup-walk`
  (subtree-bounded): INHERENT — the derivation work itself, value-compared.
- `index-resolve`: 0 on all M2 paths (no lane/worktree deltas); priced for
  the lifecycle phase (resolveCwd is O(roots) per unbound ingest,
  resolveAllUnbound O(sessions) per lane change).
- `order-snapshot` ~V per order read (list + parity): INHERENT to serving
  the view — one build per change per reader, never per row.

## Findings (latent holes with the mechanism named; beyond the 7 scenarios)

- F1. Agent-row hosting is not re-synced on pure clock ticks, and
  visibility loss seeds no ancestor recompute. Exhibiting shape: an agent
  row with live sessions hosted under a decaying finished formal host,
  plus a boundary-crossing tick. Absent from the seed corpora (no
  `audience` field → no agent rows) and day-scale jumps are outside #8.
  For J-phase: recheck hosting for the affected subtree on clock, then the
  chain seeding reverted in (7) becomes load-bearing.
- F2. `sessionRetains` day-windows are read inside computes but tracked in
  no clock set: a day-scale jump (not #8's +60 s) goes stale the same way
  the defer gap did. Same scope note as F1.
- F3 (harness, G4). Browser commit logging never worked: production
  react-dom disables `Profiler onRender`, so every browser page on every
  arm logs zero commits — counts were never affected (happy-dom uses the
  dev build). The documented `react-dom/profiling` alias breaks page boot
  (`TypeError` at init, mechanism not yet traced). Browser evidence in M2
  is therefore walls + arm stats + mounted rows, not commits. Recommend a
  G4 follow-up: fix or bless the profiling bundle before J-phase walls.

## Browser (1x fixture corpus, 211 visible rows)

Pending a quiet window (box above load 8 through the count phase): rename,
stagemove, clock × 20 per arm (hand + control interleaved) via the
extended G4 driver (`rename,stagemove,clock` page scenarios new in this
issue). Verdict metric is in-page `actionMs` (sync pipeline + microtask
drain, no paint, no poll); `taskMs` bounds the wall to paint.

## Line count (arm folder, `wc -l`, tests excluded)

3,723 non-test total (+486 over M1's 3,237, per-file in the M2 diff stat):
order +71 (members, ranks, probes), indexes +67/−(moveSeat) (seats),
deltas +31 (scan vocabulary), store +21 (scan totals, assertNever),
rollup +17 (walk/batch counts), groups +14/− (set membership, rebuild
count), visible +9, summary +6, rows +2. Test growth: m2 run (308) + tick
sets (part of hand.test.ts +119).

---

# POD-4453 NOTES — hand-rolled arm, milestone 3 (lifecycle, growth, coexistence)

## Arm changes (each: did it add a place to remember?)

1. **Rollup seats go incremental (the deferred M2 slope item).** No new
   place: `openExplicit` / `lastActive` / `staffed` (+ open counts, staffed
   refcounts, per-session snapshots) live inside `rollup.ts` beside the
   aggregates they feed — the `order.ts` members/ranks precedent, same diff
   shape. Session diffs refresh the touched issue's bucket only; open flips
   walk the ancestor chain; parent moves re-hang the moved subtree's open
   issues. The `rollup-batch` scan (~11.2k visits per computing dispatch at
   1x) is zero on every scenario; rows committed and derivations are
   identical to the M2 after-table on all thirteen steps (M2 strict gate
   green on the pre-4491 seed).
2. **Computation share timing.** `HandStore` accumulates `indexMs` /
   `rollupMs` / `rowMs` around the dispatch levels, read via `store.phaseMs()`.
   No new place: beside `scanTotals` in `store.ts` (#10); arm-local optional
   fields, shared `ArmStats` and the harness's four-field readers untouched
   (no shared/ or harness/ change, no coordinator mail needed).
3. **`spike/` holds the write-path sketch only.** Never imported by the
   production path; excluded from line counts by directory.

## Count tables

Measured on the pre-4491 seed (branch `191f627a9`–`81a08f51a`, counts
load-independent); box load 6–10 through the runs, so every wall below is
withheld and every verdict below is counts. After the rebase onto 4491's
`815e2e85f` the 1x mount parity fails exactly as the coordinator announced
(extra row in one group, byte-identical across arms, POD-4496 owns the
verdict) — the tables below are the pre-seed-fix record, the mechanism
(batch removal with identical derivations) is seed-independent.

### Growth scenario 14 (1x/2x/4x scenario corpora; visible 3,230 / 6,464 / 12,926)

| Scale | #1 heartbeat | #2 phase | #3 click (engine) | #5 stagemove |
|---|---|---|---|---|
| 1x | 0 / 0+0 / idx 0 | 1 (i0) / 1+3 / idx 0 | 0 / 0+3 / idx 0 | 1 / 1+3 / idx 0 |
| 2x | 0 / 0+0 / idx 0 | 1 / 1+3 / idx 0 | 0 / 0+3 / idx 0 | 1 / 1+3 / idx 0 |
| 4x | 0 / 0+0 / idx 0 | 1 / 1+3 / idx 0 | 0 / 0+3 / idx 0 | 1 / 1+3 / idx 0 |

Cells: rows committed / rowsDerived+rollupsDerived / indexUpdates; parity +
rebuild oracle green on all twelve. Flatness gate holds: #1–#3 counts
identical at every scale (slope on counts = 0.25 by construction — flat).
`rollup-batch` scans: 0 everywhere (was ~11.2k/22.4k/44.8k per computing
dispatch). Remaining scale-growing scan is `order-snapshot` (= visible rows:
3,230/6,464/12,926) — the harness's `snapshot()` read, one order build per
snapshot read, not event work; the browser list reads order only on
`OrderChanged`. Subtree walks stay bounded (visible-walk ≤ 2, rollup-walk ≤
2 on #5; 0 elsewhere). Phase split (happy-dom, load-contaminated, proxy
only): rollup ~0.2–1.0 ms vs index + row ~0.05–0.6 ms per event; share
reported properly at 1x/4x in the m3 note from the same records.

### Lifecycle (count-harness mechanism half; browser walls owned by POD-4489)

- coldBootstrap 1x: construction snapshots full once — 3,230 visible /
  4,867 issues / 4,304 sessions, parity + oracle green.
- principalSwitch (SMALL, fresh replica + fresh runtime): 37 visible, parity
  + oracle green, old store `listenerCount()` 0 after dispose.
- rescope 1x: replace installs (issues 4,867 → 4,877, parity + oracle green
  at the grown state), rescope back returns tables to 4,867 / 4,304 and
  visible to 3,230 (no leak; happy-dom proxy for the withheld heap ±5%).
  The ten grown rows carry no audience/sessions and stay invisible in arm
  and oracle alike — install proved by table sizes.

### Coexistence scenario 15 (SMALL, one kernel, one row source, two roots)

| Side | Solo rows / derivs | Co-mounted rows / derivs | Parity |
|---|---|---|---|
| hand arm | 0 / 0+0 | 0 / 0+0 | green both |
| legacy control | 39 / 41+1 | 39 / 41+1 | green both |

One shared heartbeat publication; each side reset before it. Neither wakes
the other beyond its solo shape; the control still says NO (39/37 commits),
so the detector is not blinded by the arm's presence.

### Mobile

`harness/native/hand.native.test.tsx` (package lane): #1–#3 with parity +
rebuild oracle green after the seat change (heartbeat 0 commits, click 0
rows + 0 derivs). No FlatList change: ScrollView-full matches the control
lane, so counts compare directly; recycling stays hardening for device
evidence.

## Stats split (methodology §6.4; full share table in the m3 note)

Per-event `phaseMs` at 1x and 4x from the growth records: the pipeline is
sub-millisecond in happy-dom and rollup-dominated (~70% of the timed
levels); index maintenance and row assembly split the rest. Under box load
these are proxies, not verdicts — the count split (derivations by level:
summary/visible/rollup bodies vs committed rows vs bucket writes) is in the
m3 JSON beside every step.

## Bundle (production vite build, this branch)

hand entry chunk 51.40 kB / gzip 13.18 kB vs control 4.55 kB / gzip
1.97 kB: delta +46.85 kB raw, **+11.21 kB gzip** (budget +60 KB gzip —
PASS). The shared `entrylib` chunk (engine + harness, 585.54 kB / gzip
170.72 kB) is common to all pages, not arm cost. (Sibling chunks for scale:
mobx 75.07 / gzip 21.51 kB, tanstack 312.44 / gzip 86.21 kB.)

## Browser (withheld)

Load never dropped below the hygiene line during the count phase (6–10),
and timing is owned by POD-4489 regardless: principalSwitch ≤ 2× control,
coldBootstrap ≤ 1.1× control (+ heap ≤ 1.1×), rescope heap ±5%, growth
actionMs slopes and the §1a p95 lines are all withheld for the leased
re-run. Counts above carry the verdict meanwhile.

## Line count (arm folder, `wc -l`, tests + `spike/` excluded)

3,962 non-test total (+239 over M2's 3,723): rollup +207 (seats + session
snaps + re-hang), store +31 (HandStats, phaseMs, timed levels). Still over
the 800–1,500 budget, openly, for the same reason as M1/M2: parity-exact
transcription of 8 rules. Test growth: m3 run (435) + spike (1 file, out
of count).

## Findings for later phases (unchanged from M2: F1 agent-hosting on ticks,
F2 sessionRetains day-windows, F3 browser commit logging) plus:

- F4 (seed, now POD-4491/POD-4496's): the scenario seed's dep edges and R3
  anchors were inert on the scenario path, so R3/R4 were under-tested there
  on every arm equally. Landed as `815e2e85f` after these counts; the new
  1x mount parity mismatch is the announced identical-across-arms failure
  and is not chased here.
