# POD-4694: hand pool layout follows the change

Landed: `e260665fd` on `integrate/4545-round-three` (ff-only, under merge-lock;
re-verified after the rebase: scaling 16/16 + groups 7/7).
Pool code at the landed SHA is what flatblock times; the only later commit on
the issue branch (`eeafce9d0`) adds result fields to the scaling test, no pool
code.

Code: `packages/worklist-proto/arms/hand/pool/worklist/groups.ts` (filed
placements, incrementally maintained working lanes, head-rank keys),
`worklist/visible.ts` (the order's membership delta: entered/left/rankMoved,
drained by `takeMoved`), `pool/pool.ts` (passes the delta to the groups
settle). Counts: `pool/worklist/scaling.test.ts` (8 changes × 1x/4x, outside
order-walk counts, header/list notices, both plants).

## 1. Design (MobX POD-4686 approach, hand idiom)

- One placement cell per issue (unchanged). The settle files exactly the rows
  that moved: reported placements plus the order's entered/left ids. A filing
  is one bucket touch: out of the old lane, into the new one
  (`counters.groupRuns` +1, `counters.groupElements` += lane members around
  it), never the visible count.
- Each group's lanes are working arrays kept sorted by insert (binary search
  + splice), never re-sorted whole: a filing places one id; a rank move
  re-places one id. No Set/Map iteration and no `Array.sort` over members in
  steady state — the F1 upkeep instrument counts those process-wide, and the
  first cut (full lane re-sort) turned its issue-edge whole-push O(bucket):
  12,126 ops at 4,000 vs 24,126 at 8,000. Incremental lanes keep it constant
  (`relations.test.ts` "in place" green again).
- Group keys sort cached head ranks (O(groups)); the settle never calls
  `host.order()` in steady state (bootstrap files it once). The scaling test
  counts elements iterated out of `host.order()` through a proxy, bound 0.
- Evicted rows unfile in the settle (counted, notified), not in
  `forgetIssue`: unfiling there bypassed the count and left stale lanes
  (`groups.test.tsx` #6c caught it).

## 2. Counts per structural change (direct pool, outside counts, 1x and 4x)

Visible rows: 732 (1x), 2,928 (4x). `orderElements`/`orderLengths` = elements
iterated out of `host.order()` / length reads through the counting proxy,
bound 0 per change. `headers` = per-group listener notices (one listener per
group, as each header holds one); `list` = grouped-view notices.

| change | 1x filings / lane / headers / list | 4x filings / lane / headers / list | order walked 1x / 4x |
|---|---|---|---|
| stage move (head row, open→fold) | 1 / 464 / moved×1 | 1 / 9 / moved×1 | 0,0 / 0,0 |
| archive (leave, excluded) | 1 / 463 left behind / emptied×1 | 1 / 1816 / emptied×1 | 0,0 / 0,0 |
| click (select + mark-read) | 0 / — / none / 0 | 0 / — / none / 0 | 0,0 / 0,0 |
| enter (new visible row) | 1 / 196 / its group×1 | 1 / 1818 / its group×1 | 0,0 / 0,0 |
| evict (row deleted) | 1 / 463 left behind / emptied×1 | 1 / 1816 / emptied×1 | 0,0 / 0,0 |
| pin (bucket→pinned) | 1 / 485 (behind+pinned) / old×1, list 1 | 1 / 1901 / old×1, list 1 | 0,0 / 0,0 |
| rank move (sort-key, same lane) | 0 / — / its group×1 | 0 / — / its group×1 | 0,0 / 0,0 |
| reparent (between present roots) | 0 / — / none / 0 | 0 / — / none / 0 | 0,0 / 0,0 |

Raw results: `harness/browser/results/hand-scaling-4694-*.json` (16 files,
this checkout; gitignored). Order re-sorts: 0 and membership flips: 0 on
every change except enter/evict/archive (exactly 1 flip each). The
scale-invariant part is the filing count (1, or 0 for non-placement changes)
and 0 order walks at both scales; lane members are O(the moved lane), the
same shape MobX closed with (1 filing + its lanes).

## 3. Plants (must fail, do fail)

- Whole-visible-order walk through the host seam: 732 elements at 1x, 2,928
  at 4x, against the bound of 0 (`plantOrderElements` in the stage results).
  Red at both scales.
- Re-file-all (every visible id out and back in): 510,204 lane touches at
  1x, 7,740,464 at 4x, against the single-change lanes (464 / 9) above.
  Red at both scales.
- The pure whole-list layout (`layoutOf` over the visible order) touches
  732 / 2,928 per run.

## 4. Gates and suite (all on the landed pool code)

- Scaling 16/16, groups 7/7 (parity #1–#7, fences, latch, window, plants),
  visible + hand pool 22/22, counts 2/2, typecheck 8/8.
- L4b whole-view gates: hand `pool/gate.test.ts` + MobX `pool/gate.test.ts`
  (3×200 each) 6/6; rollup gates 2/2; write gates-with-edits 2/2 (5 tests);
  H3 full-view probe 5 seeds × 300 (in 1–2 / 3–4 / 5 chunks) all green.
- Full package suite: all 106 files under `packages/worklist-proto` green
  (shared 19, harness 19, arms/review/browser/native 31, pool 32, gates
  above); the one red found on the way (F1 whole-push, §1) was fixed in the
  landed code and re-verified (relations 55/55).

## 5. Timing (flatblock, Mb4 matrix: noop, control, hand at 1/2/4x)

Matrix: `matrix.ts --arms noop,control,hand --scales 1,2,4 --rounds 4
--samples 5 --tag hand-4694 --host flatblock --remote-dir podium-timing-4694`
(36 runs; remote checkout with its own `.toolchain`,
`harness/web/dist` built there). STATUS: round-0 noop/control green (6/6);
hand-1x failed on the round-two entry (see §6, since fixed); the rerun with
the pool entry is queued behind the current bench holder (see §7).

| scenario | noop p50 1x/2x/4x | control p50 1x/2x/4x | hand p50 1x/2x/4x | excess slope | heap hand per scale |
|---|---|---|---|---|---|
| heartbeat | — | — | — | — | — |
| visibleHeartbeat | — | — | — | — | — |
| rename | — | — | — | — | — |
| stagemove | — | — | — | — | — |
| clock | — | — | — | — | — |
| click | — | — | — | — | — |

## 6. Browser parity finding (pre-existing, fixed forward here)

The matrix refused to time on a parity mismatch, and the first matrix run
showed the hand arm mismatching from bootstrap on every scenario and sample:
`i1026: phase arm="queued" oracle="waiting"; asking arm=false oracle=true`
(arm snapshot `1aa2491f` vs oracle `9da2200d`, identical on all 36 records).
The MobX arm at the same landed SHA passes the same probe (`parity=ok`).

Shrink (ruling step 1): the smallest reason is the page, not the pool. The
direct pool reads i1026 as waiting/true after bootstrap (probe), so the
composition is correct when settled. `harness/web/entries/hand.ts` mounted
`handArm` — the frozen round-two `HandStore` with its known correctness
bugs — while the matrix timed it as the round-three pool; MobX's entry was
switched to its pool by Mb4 (POD-4572), the hand entry never was. A
base-SHA control fails identically (same arm hash `1aa2491f`) because the
base entry mounts the same round-two arm. Arm-vs-harness decided from that
evidence: the pool is exonerated by the direct-pool probe and the identical
hashes; the entry was the defect.

Fix (ruling step 2): `entries/hand.ts` now mounts `handPoolArm` with
`HAND_POOL_ALLOWANCES.parity` (new, mirroring `MOBX_POOL_ALLOWANCES`),
first pinned by the failing-without-Chromium `harness/browser/entries.test.ts`
(red before: hand mounted the round-two arm; green after). Single-sample
probe on flatblock at the fix SHA: hand 1x heartbeat `parity=ok` (was
MISMATCH on every record). Hc2 (POD-4587) confirms its bootstrap-from-feed
change cannot move asking/phase and stays out of worklist/react.

## 7. Lease queue

`bench:flatblock` was held by Mc2 verification, then by issue #4414
(dev-mw workspace, renewed TTL ~2.5h at last check). The rerun matrix is
parked backgrounded with `--resume` (safe across kills: completed pairs are
kept) and takes the lease per invocation when the machine frees.
