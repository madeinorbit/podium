# H3: hand-rolled pool shape review (POD-4598)

**Verdict: FAIL on four lines, all four test-only. The pool's code passes
every line of the checklist.** What fails is what the tests can see:

- **H3-F1.** The F1 guard has no identity check. A `union` or
  `structuredClone` copy of a 4,000-member bucket gets past it, the same gap
  as M3's G4.
- **H3-F2.** The F1 guard's rig holds issues only, so no session edge is
  measured. A copy in the prefix index cannot fire there, even a sorted one.
- **H3-F3.** The L4b gate compares only the 11 slice fields. `activityAt`
  (the #2 fix), `originTick` and seven other row-view fields are never held
  to the rebuild. Ha4's claim that "L4b holds both paths to one rule" is
  false. Three plants of the round-two and MobX defect shapes pass the stock
  gate, and a full-view check catches each of them.
- **H3-F4.** The schema's `where.fields` / `collapse.fields` lists are input
  inventories that the relation engine trusts, and nothing checks that they
  are complete. They are complete today: I checked them on the 1× corpus and
  on the live export.

I found no correctness defect: the gate is green on 5 seeds × 300 steps, and
a new full-view check is green on the same seeds. This is the complete list
(§6). The Ha owners are closed, so each finding is its own sub-issue under
POD-4545 (§5).

- **Reviewed commit:** `c128bf833`, the tip of `integrate/4545-round-three`
  when the review started. The last commit touching `arms/hand/pool/` is
  `25aba6f04` (POD-4581, Ha4). All `file:line` below are at `c128bf833`, and
  paths are relative to `packages/worklist-proto/` unless given in full. My
  branch is that commit plus commits that touch only `harness/review/h3-*`
  and this document.
- **Independence:** I built neither pool. The 30 commits touching
  `arms/hand/pool/` at the reviewed SHA are POD-4578 (7), POD-4579 (8),
  POD-4580 (10), POD-4581 (4) and POD-4635 (1). None is from this issue, and
  I wrote no MobX pool code either.
- **Sources:** code first. I read every non-test file in `arms/hand/pool/`
  top to bottom (2,401 code lines, 3,503 with comments), plus the F1 guard,
  the gate, the counts test and the shared seams they use. Where a comment
  or note disagrees with the code, the code wins, and the disagreement is
  listed.
- **Runner:** every test ran in the foreground through the package config
  under the validation queue, from `packages/worklist-proto`:
  `bun ../../scripts/validation-admission.ts focused --label <l> -- bun --bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts <files>`.
  Source plants were applied by a script that copies each file aside, edits
  it, runs the guard, and puts it back with `cp` (a `trap` also restores it
  on exit or signal). `git status` was clean after every batch. In-process
  plants patch the pool instance, the way the pool's own tests plant.
- **Load:** 6.5–10.4 (1-minute, 7 cores). Counts and assertions only, no
  wall timings.

## 1. Checklist

| # | Check | Verdict | Evidence at `c128bf833` |
|---|---|---|---|
| C1 | Relations come from the schema only | PASS | `arms/hand/pool/relations.ts:200-247` builds one link per `belongsTo`/`prefix`/outgoing `edge` from `schema[entity].relations`, each paired with its `inverse`. It throws on a collection that no link maintains (`:240-246`). No relation or key name appears in the engine. Resolution goes only through `relationRef` (`:103-119`), `prefixCandidates` (`:526-534`) and `collapseLosers` (`:439`). Residency's rule is `coldByRule`/`viaTargetOf` from the schema (`residency.ts:204-206, 405`). Record getters come from `SCHEMA[entity].fields` (`records.ts:72-91`). `relations.test.ts:1060-1124` maintains an extra fixture relation with no arm code. |
| C2 | No relation maintenance inside derivations | PASS | Only ingest writes the engine: `tables.ts:146, 155` (`put`/`drop`) and `residency.ts:338, 374` (`forget`/`keepCold`). The engine's readers (`one`/`many`/`size`, `relations.ts:251-279`) write nothing. |
| C3 | No relation resolution inside derivations | PASS | `views.ts:300-302` `repoId` = `relations.one('issue', id, 'repo')`. `:328-330` `originRef` = `one('issue', id, 'discoveredFrom')`. `:351-353` `sessionIds` = `many('issue', id, 'sessions')`, sorted at view time. `views.ts` imports only types. Own-row reads that remain (`:289` `repoKey`) read no target. **Plant** (repoId resolved from `issue.repoId` plus a presence check): `relations.test.ts` "a planted wrong forward entry…" goes red (`expected 'POD-1' to be 'OTH-1'`). |
| C4 | No hand-maintained dependency lists (sensitivity sets, input inventories) anywhere | **FAIL (H3-F4)** | *Pool code:* PASS. A cell records what it reads through tracked doors (`cells.ts:141-163`), and no derived value lists its inputs. *What the pool trusts:* the engine re-resolves a link only when one of `linkInputs` moved (`relations.ts:122-130, 314`), which is the key field plus the schema's `where.fields`. It re-decides a collapse group only when a `collapse.fields` entry moved (`:386`). These lists are declared by hand next to the functions they describe (`shared/src/schema.ts:424, 558, 573, 580`). `validateStructure` checks only that each named field exists (`schema.ts:955-961`). My probe finds no gap today, and it is armed (§2.4). |
| C5 | A never-check in every delta handler | PASS, with a note (N5) | `pool.ts:101-112` closes the `Delta` union. `invalidate` (`:645-673`) and `release` (`:681-715`) each end in `default: unhandled(delta)`. **Plant** (a sixth `Delta` kind): typecheck fails at both, `pool.ts(672,19)` and `pool.ts(714,19)`, `TS2345 … not assignable to parameter of type 'never'`. |
| C6 | No whole-table walk outside the one declared enumeration | PASS, with a blind spot | *Tables:* walks sit only in `enumerate.ts` (`issueIdsOf` `:61-63`, `reseed` `:94, 99-104`, and the gate-only scan, diff, `knownTables` and `diffResidency`). Elsewhere a walk only empties tables (`pool.ts:612-617`) or reads the cold registry for reseed and the gate (`residency.ts:194-196`). **Plant** `[...this.fenced.issue.keys()]` in `pool.ts` → `fence/no-table-walk` fires (`555:14`). A bucket walk in `views.ts` is silent: the rule matches table names (M3 C11). *Collections:* a bucket is a `Set`, edited one member at a time (`relations.ts:470-494`). Bounded exceptions: `rootRemoved` copies a bucket whose every member moves (`:553-558`). `rootAdded` iterates the members under one root (`:537-546`, N3). A collapse re-decision reads one group (`:425-448`). `warmDependents` copies ids that all move (`residency.ts:388`). On the live export, one new issue into the 4,574-member `repo.issues` costs 2 index updates and 8 counter ops and replaces no container (§2.3). |
| C7 | Lazy construction present | PASS, with a note (N1) | A view is a cell per part, born on first read (`pool.ts:190-221`), and records are born on first access (`:463-473`). An activity cell is born when an issue first asks (`:449-460`). Cold rows are never stored: `residency.ts:279-306` registers them, and the engine links them by id. Loads batch in one 50 ms window and one commit (`residency.ts:235-250`, `pool.ts:508-517`). A dependency index key exists only while a cell reads it (`cells.ts:46-64`). |
| C8 | Untracked state read inside a derivation (pitfall j), and MobX's three defect shapes | PASS, with a note (N9) | The plain reads inside cells each follow a tracked record of the same key. The clock's `now` sits behind deadline keys (`clock.ts:328-332`). The selection is recorded under the asking id (`pool.ts:365-368`). The residency registry sits behind `asked` (`residency.ts:219-232`). The engine's maps sit behind `read` and presence (`relations.ts:257-260, 277`). The memo maps `issues`/`sessionCells` are safe because disposing a cell dirties its readers (`cells.ts:202-209`). *MobX's shapes:* (a) a removed parent's bucket stays, keyed by reference, and the scan agrees. (b) An index key is dropped only when its last reader leaves, and every registry move is a delta (`residency.ts:412, 425`). (c) A plain map read going deaf needs a cell reading around the graph. My `activity` plant is exactly that, and the stock gate misses it (H3-F3). |
| C9 | Round-two bug 1: the clock reaches derivations as an input | PASS | A time rule asks `reached(t)`/`passed(t)`, which records the cell under deadline `t` (`clock.ts:328-337`). `move` dirties exactly the crossed deadlines (`:340-352`). The lint forbids `Date.now` (**plant** in `views.ts` → `fence/no-wall-clock`). **Plant** `clock` (the clock moves but dirties nothing, round two's no-op `ClockChanged`): the stock gate catches it (§2.5). The roll-ups are Hb3 stubs (`views.ts:63-77`). Re-check at Hb3 that each roll-up reads time only through `reached`/`passed`. |
| C10 | Round-two bug 2: chain invalidation inputs are exactly what was read | PASS by construction; **its gate is blind (H3-F3)** | Invalidation is the recorded reads, level-ordered, pulled on read (`cells.ts:150-199`). There is no early-stop rule to get wrong. **Plant** `chain` (a changed cell at level ≥ 2 does not dirty its readers): the stock gate misses it on 3 of 3 seeds, and the full-view check catches it on every seed (§2.5). |
| C11 | Round-two bugs 3 and 5: order and groups under batched rank moves | N/A at this SHA | No order or group code yet: `snapshot()` returns `EMPTY_ORDER` (`pool.ts:175-178, 561`), and the a1 list is table order. The gate draws both shapes (§2.2) but runs `oracleEvery: 0`. Re-check at Hb2 with the oracle on. |
| C12 | Round-two bug 4: evict then re-add re-seats relations | PASS | Buckets are keyed by the reference, not by the target's presence (`relations.ts:20-22, 470-494`). `one()` checks presence at read time (`:251-261`). A removed issue's cells are disposed and re-born on re-add (`pool.ts:681-696`), and the id-list listener is told either way (`:685`). `relations.test.ts:222` covers it. **Plant** `reseat` (a removed row takes its inverse buckets with it): §2.5. |
| C13 | Stats honest | PASS, with notes (N3, N6) | `indexUpdates` counts elements (`relations.ts:564-566`, called per member, forward entry, index entry and collapse entry). `rowsDerived` counts view-cell runs (`pool.ts:197`). `notifications` counts commits with deltas (`:636-641`). `rollupsDerived` is 0 (`:137`). Each matches `arms/hand/README.md:130-144` except for the N6 wording. |
| C14 | Size within reason | PASS | Non-test `pool/`: 2,401 code lines (3,503 with comments). That covers tables (130), cells (200), clock (62), records (58), relations (416), residency (293), views (246), pool (540), enumeration (227), rebuild (58), arm (93) and the React and native slots (78). Nothing is dead: every export has a production or gate caller. Round two's hand arm was 3,988 lines (audit §3.3). |
| C15 | L4b correctness gate, 5 seeds × 300, run by me | PASS, with its reach limited (H3-F3) | 5 of 5 seeds green, 1,505 rebuild comparisons, 1,505 relation and partition checks, and 5 full-residency checkpoints. All five plants fail every seed (§2.2). |
| C16 | L6a lint clean, and able to fire | PASS | `bunx eslint --config eslint.config.mjs arms/hand/pool` exits 0. Four plants tested: a table walk, `Date.now` and module state each fire, and a bucket walk is silent (C6). |
| C17 | Fence cells through `runFenceStep`, live-shaped 1× | PASS | Clean #1 charges 2 reads (session 1, worktree 1), and #2–#4 charge 1 each. Commits are 0/1/1/1, and no row loads after any sample. This is identical to MobX's cells (the LESSONS comment) under both load windows (§2.1). |
| C18 | A step counts the load its own change triggers (M3 G2 plant) | PASS | The cold-issue plant through the shared fence: #2 is charged **2,839** reads (issue 2,833, session 3, worktree 2, repo 1) with 3 rows loaded in the step and 0 after the sample. It fails `read 2839 rows, budget 3` under both windows, the same numbers as MobX (§2.1). |
| C19 | A wrapped flush is refused (M3 N9) | PASS | `runFenceStep(…, () => feeds.flush(), …)` rejects with `not an openFenceFeeds flush` (`harness/src/fence-scenarios.ts:390-395`). |
| C20 | The F1 guard sees bucket-sized copies whatever idiom makes them | **FAIL (H3-F1, H3-F2)** | `relations.test.ts:880-1003` `elementOps` patches `Set`/`Map` methods, their iterators and `sort`, on a rig of issues only. Against the real guard, `union` and `structuredClone` bucket copies are green, and all three prefix-index copies are green because the rig places no session (§2.3). |

## 2. Evidence I ran

### 2.1 Fence steps and the step-load plant (`harness/review/h3-step-load.test.tsx`)

`Tests 3 passed`. The arms are those of M3's probe: D is the never-closing
window with no plant, A is the same window planted, C is a microtask window,
and B is a microtask window planted. The plant sits in `inputs.session`,
which the #2 session's activity cell calls. Loads are counted by my wrapper
on the residency's per-row install, not by pool counters, which a stats reset
zeroes.

| Arm | #2 charged | by entity | loaded in step / after sample | commits | reads fence |
|---|---|---|---|---|---|
| D | 1 | session 1 | 0 / 0 | 1 | pass |
| A | **2,839** | session 3, issue 2,833, worktree 2, repo 1 | 3 / 0 | 2 | **fail** `read 2839 rows, budget 3` |
| C | 1 | session 1 | 0 / 0 | 1 | pass |
| B | 2,839 | same | 3 / 0 | 2 | fail |

The 2,833 issue reads are the a1 id list re-walking the table's keys after
the load (`pool.ts:379-389` → `enumerate.ts:61`). Hb1 replaces that list.
Clean #1–#4 under both windows: 2/1/1/1 charged, 0/1/1/1 committed, and 0
loaded after any sample. A wrapped flush is refused.

### 2.2 L4b gate, 5 seeds × 300, live-shaped 1× fixture

`POD_POOL_GATE_FIRST_SEED=k POD_POOL_GATE_SEEDS=k POD_POOL_GATE_STEPS=300`,
one seed per run, `arms/hand/pool/gate.test.ts -t "correctness gate"`, at my
branch (pool code identical to `c128bf833`). Each run gave `Tests 1 passed`,
in 220–239 s. Cells are in
`harness/browser/results/hand-pool-gate-1x-1x300{,-from-2..5}.json`
(gitignored).

| Seed | Steps / skipped | Rebuild / relation checks | Cold writes / rows loaded / warmed | Shapes: evictThenReAdd, twoRankMoves, rankMoveWithinGroup, clockDecay, offerRemovedOnFinishedChild | removal-deaf | relink-skipped | cold-deaf | cold-relink-skipped | registry-kept |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 300 / 0 | 301 / 301 | 115 / 8,281 / 32 | 8, 8, 4, 26, 12 | rebuild, step 15 | relations, 14 | partition, 9 | relations, 24 | checkpoint |
| 2 | 300 / 0 | 301 / 301 | 153 / 9,707 / 21 | 14, 9, 3, 15, 16 | rebuild, 32 | relations, 0 | relations, 20 | relations, 20 | checkpoint |
| 3 | 300 / 0 | 301 / 301 | 134 / 4,164 / 18 | 20, 6, 0, 6, 9 | rebuild, 19 | relations, 14 | relations, 3 | relations, 3 | checkpoint |
| 4 | 300 / 0 | 301 / 301 | 129 / 6,916 / 15 | 6, 6, 7, 6, 29 | rebuild, 3 | relations, 20 | relations, 29 | relations, 22 | checkpoint |
| 5 | 300 / 0 | 301 / 301 | 109 / 5,519 / 14 | 4, 2, 5, 10, 14 | rebuild, 1 | relations, 1 | partition, 1 | relations, 7 | checkpoint |

Zero divergence on the clean pool. Every plant fails every seed, each caught
by its intended check.

### 2.3 Bucket upkeep: the code, and the F1 guard

**The code, on real shapes** (`harness/review/h3-shape-probes.test.ts`, with
`H3_LIVE_EXPORT` set to the POD-4552 export, fetched with
`podium issue artifact 4552 --get 1` into the gitignored `harness/.live/`).
Each probe inserts one row into the largest buckets. "Counter" is a verbatim
copy of the hand guard's `elementOps` over the whole apply. "Replaced" is the
identity check.

| Corpus | largest `repo.issues` / `worktree.sessions` / resident `issue.sessions` | new issue: indexUpdates / counter / replaced | new session: indexUpdates / counter / replaced |
|---|---|---|---|
| fixture 1× | 4,055 / 6 / 8 | 2 / 8 / 0 | 8 / 15 / 0 |
| fixture 4× | 16,070 / 7 / 8 | 2 / 8 / 0 | 8 / 15 / 0 |
| **live export** | **4,574 / 2,263 / 79** | **2 / 8 / 0** | **11 / 18 / 0** |

The live-shaped fixture now has one dominant repo, as the live export does.

**The F1 guard, planted** (`arms/hand/pool/relations.test.ts -t "M3 F1"`,
source plants in `relations.ts`):

| Plant | Where | F1 guard | Identity check (`h3-index-identity.test.ts`, in-process, 4,000 issues + 4,000 sessions) |
|---|---|---|---|
| clean | – | green | green: nothing replaced on any edge |
| PB4 `new Set(bucket)` (the control) | `point()` after `bucket.add` | **red** (`expected … to deeply equal`) | – |
| PB7 `bucket.union(new Set())` | same | **green: missed** | **red**: 4,002 (new issue), 8,002 (new session) |
| PB8 `structuredClone(bucket)` | same | **green: missed** | **red**: same |
| P4 `new Set(set)` | `place()` after `set.add` | **green: cannot fire** | **red**: 8,002, `session.worktree.under:/repo` and `:` |
| P7 `set.union(new Set())` | same | **green: cannot fire** | **red**: same |
| P4s `new Set([...set].sort())` | same | **green: cannot fire** (a 4,000-element sort, never run) | – |

In-process, the guard's counter sees P4 (16,029 ops) and does not see P7
or P8 (20 ops, under its bound of 100). So on a rig with sessions the counter
would catch P4, and it would still miss P7 and P8. The two findings are
separate.

### 2.4 Declared inputs (`h3-shape-probes.test.ts`)

Every `where.test` and every collapse function (`groupKey`, `keepsGroup`,
`rank`, and the `recency` field) ran over every row of the 1× corpus and of
the live export through a recording proxy. I found **no undeclared read**.
The planted schema (`session.issue.where.test` also reads `status`) is named:
`session.issue.where reads status`.

### 2.5 The gate's reach (`harness/review/h3-gate-plants.test.ts`)

*Control arm:* the stock gate's checks (rebuild after every step, every
relation against a scan, and the partition), rebuilt in the probe because
the gate does not export them. *Full-view arm:* the same checks, plus every
resident issue's whole `RowView` against the rule table run directly over the
feed's rows. The clean pool is green on the full-view arm on 5 of 5 seeds ×
300 steps.

RESULTS-TABLE

The stock rebuild compares `sliceRowOf(view)` (`shared/src/row-view.ts:289-303`).
So a part that reaches none of the 11 slice fields is held to nothing
incremental. The only test of such a part against the legacy oracle is the
fidelity test, on a static corpus (`gate.test.ts` "own-row and one-hop
fields").

## 3. Findings

### H3-F1 (FAIL): the F1 guard has no identity check

**What.** `relations.test.ts:882-914` counts calls to patched prototype
methods. `Set.prototype.union` copies the receiver natively, and
`structuredClone` calls no prototype method. As a copy-on-write of the
4,000-member bucket, each passes the guard (§2.3). This is M3's G4 on this
arm, and it is the gap the addendum asked me to check first.

**Fix (test-only).** Beside `elementOps` in "bucket upkeep is O(1) in the
bucket", record every container the engine holds before and after each edge,
and assert that none was replaced. `harness/review/h3-witness.ts`
`held()`/`replaced()` can be moved in as they are. They cover `forward`,
`placed`, `buckets`, `under` and each nested set, and the collapse maps. Keep
`elementOps`. **Acceptance:** PB7 and PB8 fail the guard, and clean code
stays green.

### H3-F2 (FAIL): the F1 guard measures no session edge

**What.** The guard's rig is issues in one repo (`relations.test.ts:916-938`).
A new session touches three buckets (`worktree.sessions`, `issue.sessions`
and the repo's), one `under` entry per ancestor path, and possibly a collapse
group. None of that is measured, so a plant in `place()` cannot fire. P4s
sorts 4,000 elements per new session and stays green. MobX's rig puts 4,000
sessions under `/repo` for this reason (M3 §6.2).

**Fix (test-only).** Add 4,000 sessions under one root and in one issue
(and 8,000 for the growth comparison), with a new-session and a
removed-session edge. Restate the per-edge bound (one element per link
touched, plus one index entry per ancestor path). **Acceptance:** P4 and P4s
fail the guard, P7 fails through H3-F1's identity check, and clean stays
green.

### H3-F3 (FAIL): the L4b gate cannot see most of the row view

**What.** The gate's rebuild comparison is over `snapshot()`, whose rows are
`sliceRowOf(view)`: id, displayRef, title, phase, progress (2), working,
asking, band, repoKey and closed. `activityAt`, `originTick`, `selected`,
`pinned`, `sortKey`, `createdAt`, `seq`, `foldAt` and `dismissed` are never
compared incrementally. Ha4's note says that computing `sessionActivity`
directly in the rebuild means "L4b holds both paths to one rule"
(`arms/hand/NOTES.md:23-25`, `docs/measurements/POD-4581-a.md:141-144`). That
is false: `activityAt` never reaches the comparison. Three of my plants pass
the stock gate on every seed I ran, and fail a full-view check (§2.5):

- `activity`: the MobX gates' "plain Map read inside a derivation";
- `presence`: an untracked presence check;
- `chain`: round two's unsound early stop.

Each one breaks a part that the #2 fence, the ⤷ tick or Hb3's roll-ups
build on.

**Fix (test-only).** In `gate.test.ts` `checked()`, per compared step, hold
every resident issue's whole `RowView` to the rule table run directly over
the feed's rows. `h3-gate-plants.test.ts` `rebuildViews()`/`diffViews()` does
exactly that, and it is green on 5 × 300. Add the `activity` plant as a sixth
plant that must fail every seed. **Acceptance:** the plant fails every seed,
caught by the view check, and clean stays green.

**Not only this arm.** The MobX gate compares the same `sliceRowOf`
snapshot. I did not review the MobX pool here. The coordinator should
decide whether Mb carries the same check.

### H3-F4 (FAIL): the schema's input lists are trusted, not checked

**What.** The engine skips re-resolving a link when none of `linkInputs`
moved (`relations.ts:314`), and skips re-deciding a collapse group when none
of `collapse.fields` moved (`:386`). Those lists (`schema.ts:424, 558, 573,
580`) are sensitivity sets written next to the functions they describe. If
a `where.test` or collapse function starts reading a field that is not
listed, the relation goes stale on a change of that field. The gate would
see it only if the generator happens to move that field. Today they are
complete (§2.4). The MobX engine uses the same `linkInputs`, so this
concerns both arms.

**Fix (either one).** Move the probe's `inventoryGaps` into
`shared/src/schema.test.ts`, so a list is checked against the corpus rows
(test-only), or make the engine compare `where.test(before)` with
`where.test(after)` (and `groupKey`/`keepsGroup`/`rank`/`recency` before and
after), which removes the lists. Both are O(1) per link. **Acceptance
(test-only form):** the planted `status` read is named, and the real schema
passes.

## 4. Notes (not send-back)

- **N1. Cells never retire while their row lives.** An activity cell stays
  after its issue leaves. Each change of the session re-runs it (1 cell run
  per heartbeat, 0 without the orphan; `h3-shape-probes` "a session heartbeat
  after its issue left"). `snapshot()` creates a view cell for every resident
  issue (0 → 2,832 on the 1× fixture), and the drain keeps them current from
  then on. At a1 every resident row is mounted, so nothing changes. Once Hb1
  windows the list, `rowsDerived` will count views that no row shows, while
  MobX suspends unobserved computeds. This is a stats comparability point for
  Hb4.
- **N2.** `views.ts:351-353` `sessionIds` copies and sorts the whole
  `issue.sessions` bucket on each membership change. This is order imposed
  at view time: at most 190 members on the live export, and MobX does the
  same (M3 §5.1 C3).
- **N3.** `rootAdded` (`relations.ts:537-546`) iterates every member placed
  under the new root, including members that stay at a longer root, and
  `indexUpdates` does not count the skipped ones. The schema doc §4.3 bounds
  this ("the members under one root"). It is MobX's N6.
- **N4.** Entity names in what should be schema-driven code:
  - `residency.ts:74, 85-87` names the loadable kinds, contrary to its
    header's "No entity or field is named here".
  - `tables.ts:159-215` hand-codes the repo-from-lane composition (MobX
    N5).
  - `pool.ts:685-690` and `:700-701` name `issue`/`session` in the release
    handler, because only those entities have cells.
- **N5.** `apply` (`pool.ts:575-576`) branches on `event.type === 'replace'`
  with an implicit else. `RowSourceEvent['type']` has two members today; a
  third would be ingested as an update, with no never-check.
- **N6.** The README says `notifications` is "one per feed event that wrote
  a table slot" (`README.md:135-137`), but the code counts any commit with a
  delta. A cold row's update that moves a relation, or a registry move, is
  counted with no table write.
- **N7.** `clock.ts:16` says `now` is "the one plain read in `pool/`". That
  is false: see C8 for the others, each made safe by a tracked record. This
  is MobX's N1.
- **N8.** `Residency.loading` queues a load and arms a timer from inside a
  cell (`residency.ts:219-250`). This is the deliberate load on first
  access, as MobX's N2.
- **N9.** A cold row's update always reaches the engine as an insert
  (`residency.ts:374`, `prev` undefined). So a heartbeat on a cold session in
  a resume-twin group re-decides the group and reads every peer back through
  the feed (`relations.ts:393-401` never short-circuits). This is bounded by
  the group, and uncounted.

## 5. What happens next

- The Ha issues are closed, so each finding is filed as its own sub-issue
  under POD-4545: H3-F1 to H3-F4. All four are test-only.
- By this issue's brief, Hb1 (POD-4582) stays blocked until a re-review
  records PASS. For M3's test-only G4, the operator decided that it would not
  block Mb1. That decision is the operator's again here.
- **Re-review:** run `harness/review/h3-*.test.ts` at the new SHA (with
  `H3_LIVE_EXPORT`), plant PB7, PB8, P4, P4s and P7 against the landed F1
  guard, run the `activity` plant through the landed gate, run the gate at
  5 × 300 and the package lint, and record PASS here with the SHA.
- **Carried to Hb2/Hb3 (not findings now):** re-check C9 and C10 against the
  real roll-ups, and C11 against the order and groups, with the gate's
  oracle on.

## 6. Completeness

This review names every concern I have with the hand pool and its
instruments at `c128bf833`. Each one has a plant or a probe. A later new
finding on this code would need a reason it could not be seen here. The two
things I could not check are the roll-ups and the order, because they do not
exist yet (C9–C11).
