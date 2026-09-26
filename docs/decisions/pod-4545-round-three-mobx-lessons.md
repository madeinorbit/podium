# Round three: lessons from the MobX build (M4, POD-4597)

What the MobX pool + worklist (Ma1-Ma4, M3, Mb1-Mb4, Mc1-Mc2, POD-4678,
POD-4686) taught the hand-rolled build. Lessons, not verdicts: no substrate
ranking here. Sources: `arms/mobx/NOTES.md`, `arms/mobx/README.md`,
`docs/measurements/POD-4568-a.md`, `POD-4572-b.md`, the M3 review
(`pod-4545-round-three-shape-review.md`), L1a-L1c docs, Mc2/POD-4686/POD-4678
close comments. MobX code at `packages/worklist-proto/arms/mobx/pool/`.

## 1. Contract amendments (clause, resolution, absorber)

| Clause | Ambiguity and resolution | Absorb |
|---|---|---|
| Schema R3 prefix seats | Seats resolve against scanned lanes only; legacy also roots at the issue's own `worktreePath` (orphans `i3485`/`i4944`) | POD-4671 (open) -> schema doc |
| Row-view `activityAt` | Legacy: retained seats' stamps, else `updatedAt`, else 0, with `\|\|` fallback; subtree half raised by nested seats | POD-4679 (done) -> L1b doc |
| Gate `SliceRow` | 11 fields; `originTick` + 7 more never held to rebuild -> whole-view check via shared `diffViews`, observed arm | POD-4674 (done) -> L4b |
| Schema `where`/`collapse` inputs | Engine trusts input lists unchecked | POD-4675 (done) -> schema doc |
| Repo-from-lane | Hand-coded in `tables.ts`; hand pool needs the same routing | NEW child -> shared feed layer (M3 N5) |
| Draft-title first member | First member skipping shells/archived/headless; invisible below 4x (`i13682`); `SliceRow` still lacks `originTick`, held via `diffRelations` | NEW child -> L1b doc |
| Write display rule | Kernel fold differs from contract on pending rows; oracle must consume the delivery stream in order (W8 is order-sensitive) | NEW child -> L1c doc (code: `gen/write-oracle.ts`) |
| Cold rule | One rule, not three copies: `coldByRule`/`viaTargetOf` in `shared/src/schema.ts` | Done, no issue -> schema doc §5.1 |

## 2. Relation cases and their resolution

| Case | What bit | Resolution |
|---|---|---|
| Evict / re-add | Removed resident parent kept a stale observable bucket; child's move wrote the plain twin | Write a bucket where it lives; residency places only missing buckets |
| Prefix re-homing | New root needs members without a scan; removed root must hand down | `under` ancestor index; new root reads it, removed root probes its own ancestors once |
| Edge direction | Views resolved `repo`/`origin` from the own row, bypassing the engine (M3 F2) | `one()` reads forward slot + presence; lint forbids `views.ts` -> `relations.ts` |
| Resume twins | Two rows, one edge | `session.collapse` + `collapseLosers` in shared schema; collapsed rows contribute no edge |
| Cold twins | Cold rows need links without observables | Plain twin slots; every plain write reports the row's residency atom |
| Registry deafness | Plain-Map node lookup tracked nothing; re-added parent left 5 descendants unplaced | Observable node registry |
| Residency atom drop | Untracked presence check deleted a cold atom a visibility node still observed | Only the maker drops its atom |
| Repo lifetime | Repo dropped with its holding lane | `releaseRepo` asks `repo.worktrees` before dropping |

## 3. Roll-up shape that held under the gate

| Piece | Rule |
|---|---|
| Combines are pure | `aggregate({own, children})`, `unitsOf({children})`; type-level proof, no store in inputs |
| Two trees | Attention over NEST children (`nestParent` inverse); progress over declared `parent`/`children` |
| Filings, not re-lists | `nestedBy` + `childrenBy`, one reaction per node; #7 reparent reads 1 vs 21 |
| Root without a walk | Every aggregate carries open + finished verdicts; the row picks at the end |
| Member contributions | One computed per member model; the parent walks the cached list, never member rows (#2 reads 1, was 4) |
| `seatActivity` | Subtree raise via retained seats; `activityCached` plant must fail every seed |
| Chain proof | Depth-4 chain: 1 row read vs 15, compositions exactly depth + 1; `everyAggregate` plant (737 vs 5) moves only the count |

## 4. Instrument failures found

| Instrument | Blind spot | Mutation that exposed it | Fix |
|---|---|---|---|
| `bucketElements` counter | A copy the code does not count is invisible | Copy-and-sort flush keeping the counter at 1 | `countedOutside`: patch `ObservableSet` proto + `sort`, read no pool counter (M3 G1) |
| `counts.test.tsx` window | A step's own load lands after the sample, charged to no step | Cold-issue plant: 2 reads pass where 2,839 should fail | `runFenceStep` awaits `settleLoads()` inside the step, refuses leftovers (M3 G2) |
| F1 guard v1 | Plain `Set`/`Map` copies (prefix index `under`) | `new Set(set)` copy-on-write stays green | Count plain `Set`/`Map` writes, deletes, iterators, `Array.from` (M3 G3) |
| F1 guard v2 | Native copies call no patched method | `set.union`, `structuredClone` copy 8,002 elements green | Identity check: no held set replaced by another object (M3 G4) |
| #10 reads via mirror | Iterating an unfenced mirror is an accounting fix, not work | `[...seats].sort()` over the mirror passes | Fence the mirror, then maintain each seat list sorted at the bucket delta (POD-4678) |
| Groups `keys` counter | A walk through a plain map is invisible to map-read counts | Coordinator's verbatim order-walking mutation passes | Counting proxy on `host.order()`: 0 elements per change at 1x and 4x (POD-4686) |
| Gate relation scan | — (this one worked) | Stale bucket, untracked atom, plain registry all failed first | Per-step live-vs-scan check + observed arm + full-residency checkpoint |

Standing lesson: count what is walked, through a seam outside the pool. Never
trust a counter the code under test keeps, a walk counted on one data
structure, or a step that settles after its sample.

## 5. Fence findings (shared fence, 1x, live-shaped corpus)

#1 heartbeat 2/3 reads, 0 commits; #2 phase 1/3; #3 click 1/3 (budget 3, not
0: POD-4619); #4 rename 1/3 reads, commit fence excepted until the visible set
exists (hidden spin-off `i933`); #5 stage move 1/24; #6a-d 5/16, 1/15, 1/15,
2/30; #7 reparent 1/21; #8 tick 0/0; #8b grace tick 6/144; #10 burst 101/168
(was 192 + 92 family term). A repo read costs two fence keys (repo + lane).
#2's target family (3) equals one level's budget (3), so a sibling re-read
alone cannot fail there: future targets need families larger than the budget.

## 6. Lazy-loading boundary

Cold rule is the schema's (`coldByRule`): closed issues and sessions of closed
issues stay out of the tables, linked through plain twins. First access is a
derivation reading through a lazy relation: answer `loading`, queue the row,
one 50 ms window hydrates every queued row by id in one action. Progress reads
a cold child's R-ROLL facts through a counted, fenced, tracked cold read and
never loads (loading 282 rows healed the `coldRelinkSkipped` plant 2/3 times);
attention keeps the pending marker. A reopen installs the row plus its
cold-inheriting sessions at once; only `replace` re-partitions. `readAt` lives
in a side lane so a cursor-only update skips the slot write. A disposed
`RowSource` throws on read (a quiet `undefined` once disguised a 54-row
rollup bug as a gate failure). 376/732 visible rows are cold at first paint
(1,504/2,928 at 4x); repopulating all of them is the window's job, not the
pool's.

## 7. Harness quirks

Production pages compile MobX enforcement out, so the browser driver fails a
run on ANY console warning/error (plants prove both paths) and the native lane
runs under the warn trap. A wrapped `feeds.flush` silently disabled lazy-arm
detection: pass the feeds' own `flush` (now refused otherwise). The pre-step
settle is uncounted by design; a step's own loads must land inside the step.
Rescope must stage scans as well as rows, or harness artefacts become
allowances. Draft-title defects show only at 4x. Load above 8 fails a timing
run outright. Round-two `it.fails` tests guard nothing: delete with the code.

## 8. Numbers

L4b gate of record: 20 seeds x 300 steps green, 6,020 rebuild + 6,020
relation/partition checks, 4 plants failing every seed. Whole-view gate: 5 x
300 green on the live-shaped fixture, 1,505 rebuild + 1,505 relation checks, 5
checkpoints, 7 plants. Mc2 truth gate: 20 x 300 green, 30 oracle checks per
seed, 0 failed, 0 healed; kernel-vs-reference disagreements 0-8 per seed go to
the decision document (legacy flicker the prototype removes).

Re-time after POD-4686 (`results/4686-final`, flatblock, 36/36 ok, load <= 5.8):

| Scenario | Mb4 p50 1x/2x/4x | Now p50 1x/2x/4x | Mb4 slope | Now slope | 1x p95 |
|---|---|---|---|---|---|
| click | 13.7 / 30.4 / 82.3 | 13.3 / 28.4 / 69.0 | 5.06 OVER | within (-2.50) | within |
| heartbeat | 17.1 / 29.8 / 63.3 | 19.1 / 31.7 / 64.8 | 1.70 OVER | within (0.52) | OVER |
| rename | 7.1 / 14.4 / 37.0 | 6.9 / 15.3 / 35.8 | 1.35 OVER | 6.70 OVER | OVER |
| stagemove | 11.2 / 21.6 / 51.4 | 11.4 / 24.9 / 57.9 | 2.88 OVER | 5.36 OVER | within (was OVER) |
| visibleHeartbeat | 18.1 / 32.6 / 68.3 | 17.8 / 35.1 / 66.6 | 5.20 OVER | 3.64 OVER | within |

Counts prove per-change work no longer follows the list (stage move: 1 filing,
0 order elements; click: 0 maintenance reactions); the remaining 4x slope
sits on paths the pool cannot touch, on a pool page holding 85 / 161 / 311 MB
at 1x/2x/4x against a 21 / 37 / 68 MB floor (Mc4). Rename's slope is
ill-conditioned (1x excess -0.5 ms). Lifecycle at 1x: cold bootstrap 775.7 ms
vs control 214.5, switch 639.8 vs 254.0, retained heap 81.1 vs 22.6 MB: pool
construction (one node + reactions per known issue), recorded not chased.
Bootstrap observables (spy adds, no models): lazy 15,547 vs all-resident
29,636 at 1x; 62,622 vs 119,232 at 4x (Linear's 80-100k range). The seat
mirror adds 5,781 (+2.7%) at both scales, no new nodes/reactions.

## 9. Module map (`arms/mobx/pool/`, non-test lines; 12,306 total)

| Module | Lines | Job |
|---|---|---|
| `worklist/visible.ts` | 1,376 | R-VIS nodes, maintained visible set, order |
| `pool.ts` | 823 | Tables host, ingest actions, read-state lane, handles |
| `relations.ts` | 775 | Schema-driven engine: forward maps, buckets, prefix index, twins |
| `worklist/rollup.ts` | 768 | Pure combines, per-node filings, seat activity |
| `worklist/scaling.test.ts` | 699 | O(change) counts with page observers (test, listed for comparability) |
| `worklist/rollup.test.tsx` | 818 | Parity + fences for roll-ups (test) |
| `gate.test.ts` | 721 | L4b correctness gate (test) |
| `residency.ts` | 589 | Cold rule, atoms, 50 ms load windows, hydrate |
| `worklist/groups.ts` | 575 | Maintained filing, view-time lanes, head-rank key order |
| `worklist/groups.test.tsx` | 518 | Group parity + fences (test) |
| `views.ts` | 499 | Row-view parts as split computeds, `one()`-based targets |
| `write/edit.ts` | 444 | Pending overlays, rewind, receipts, supersede |
| `worklist/visible.test.tsx` | 403 | Visible parity + fences (test) |
| `write/settle.test.tsx` | 385 | Echo/remote/duplicate count cells (test) |
| `enumerate.ts` | 335 | The ONE walking module + from-scratch scan |
| `write/gate-truth.test.ts` | 917 | Truth-feed gate + write plants (test) |
| `relations.test.ts` | 1,322 | Engine tests + outside-count F1 guard (test) |
| `residency.test.tsx` | 726 | Loader, atoms, evict/re-add (test) |
| `tables.ts` | 272 | Borrowed-row maps, repo-from-lane composition |
| `rebuild.ts` | 213 | Optimism-aware from-scratch oracle |
| `models.ts` | 224 | First-access models, schema-installed getters |
| `react/list.tsx`, `native/list.tsx` | 208, 130 | Windowed lists |
| `clock.ts`, `arm.ts` x2, `known-gaps.ts` | 139, 266, 118 | Deadlines, handles, named allowances |
| `enforce.ts`, `mobx-trap.ts`, `pending.ts`, rows | 77, 34 | Enforcement, log mirror, slots |

Hand-build comparison rule: same corpus, same shared fences, same gate
seeds; match the count cells (§5) and the per-change bounds (§4, §8) before
comparing walls. Test lines are load-bearing guards here (plants, outside
counts, identity checks): count them, do not discount them.
