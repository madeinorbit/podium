# arms/mobx — notes

## Round three: a-phase gates, a4 (POD-4568) · 2026-09-23

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
