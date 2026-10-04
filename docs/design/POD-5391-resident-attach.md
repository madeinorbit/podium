# Pool attach bounded by resident rows (POD-5391)

**Ask (POD-4286, 2026-10-03):** make the pool's attach reseed O(resident) instead of O(all rows), properly, in residency/relations/enumerate/row-source/pool. Keep the same results, census and sidebar fixtures, with paired phone warm-start and web startup before/after.

**Finding:** the O(all rows) attach is not incidental. About fifteen product readers and the rebuild gate's partition contract depend on the pool holding every cold row. An O(resident) attach therefore needs three things first: indexed cold queries outside the pool, those readers moved onto them, and the gate contract restated. Done alone, the attach change would only move the cost into the first screen that enumerates cold rows. The phone work screen does that at mount (below).

## What the attach does today

`create.ts:22-31` builds the pool, then `pool.apply({type:'replace', rows: snapshot(session) + snapshot(issue) + snapshot(worktree)})` → `enumerate.ts reseed`.

Per cold row (99% of 11,305 rows on the phone fixture), the attach does all of the following:
- `residency.place` → `keepCold` → `register`: cold id, via target, a copied declared summary, finish bounds, the dependents index, atom and listener notifications. Measured at about 130 ms.
- `relations.changed(entity, id, undefined, row)`: a full relink with no `before`, so cold forwards, cold buckets, collapse groups, prefix `under` sets, the issueless subset and every cold issue's `worktreePath` as an extra root. About 75–108 ms.
- `pool.apply` calls `firstTaskState(id)` for every issue, which decorates every cold issue's summary through `coldFlatUntil`.
- `sidebarRosters.queueSession` / `sync` for every session, cold included (cold lane summaries). About 33 ms.
- Upstream, `row-source.snapshot` resolves every row: `sessionView` per session, the dependency/closure joins per issue. About 78 ms.

## Who needs cold rows (verified survey, file:line in the issue's survey)

**Readers that enumerate every known id** (resident ∪ `residency.ids(..., tracked)`):

| Reader | Where it runs | Needs |
| --- | --- | --- |
| `command-launch-source.ts:31,62` catalog | **phone work screen at mount** (NewWorkButton), inbox, web palette | every issue id; every session's `isCollapsed` and `orderKey`, then its summary |
| `mobile-inbox-views.ts:30-45, 79-83` | phone inbox | every session's collapse and summary; every issue's summary, to find proposed issues and walk parents |
| `mobile-inbox-source.ts:38-42` | phone reference chips | every issue's `repoId` |
| `chat-context.ts:24, 76` | phone and web | every issue's and session's summary (filed separately by POD-4286) |
| `settings-views.ts:28`, `automation-views.ts` | settings | every session's setup summary |
| `header-views.ts:75, 184, 200, 234`; `header-sessions.ts` via `seedHeaderSessions` | web header | cold session status and cwd; issue worktreePath, stage, closed fields |
| `issue-page.ts:128, 291, 320`, `shell-views.ts:56, 71`, `mission-view.ts:846` | web | every issue's or session's summary |
| `issue-board-source.ts:347, 393, 708` | web board | every cold issue's summary fields |
| `session-pane.ts:21` | phone session | whether any cold session exists |

**Rule evaluation needs other rows' facts:**
- An issue's `keptBy.members` needs the keep deadline of every session naming it, hot or cold.
- The `lane` source needs the issueless subset of every lane.
- `issueCanShow` walks ancestors' summaries and coldness.
- A session's `via` needs its issue's full rule.

**Relations hold cold members in hot buckets.** `issue.sessions`, `worktree.sessions` and its issueless subset, `treeChildren`, `spinOffs`, `startedIssues`, collapse groups, prefix roots: all are read by derivations (`visible.ts`, `issue-page.ts`, `mission-view.ts`, `views.ts`, the sidebar roster) that count or list cold members.

**Gate contract.** `worklist-proto/harness/src/adapters/mobx-rebuild.ts`:
- `diffResidency` requires every feed row to be resident XOR `isCold`, with `ids()` equal to the declared-rule counts (`cold-rule.test.ts:143-207`).
- `diffRelations` holds `one`/`many`/`subset` of every known row, cold included, to a from-scratch scan.

## Design

**Principle:** the pool holds resident rows plus only the cold rows something has asked about. Every other cold fact is answered by an index outside the pool, maintained incrementally by the row source from replica events. The replica already holds every row; the pool must not mirror it.

1. **Row-source cold indexes (new, `shared/row-source.ts`).** Plain maps over raw replica rows, seeded once at row-source creation, then O(1) per change. That seed is a cheap scan the row source already performs for its joins: about 40–80 ms here, and the floor until the kernel persists indexes. Indexes:
   - the **candidate-resident set**: issues whose own predicate is false; closed issues whose `shownUntil` or any member/lane keep deadline is still ahead; sessions not ended or still within their keep window; and the rows those depend on (ancestors, via targets);
   - keep deadlines per owner issue and per lane;
   - sessions by issue, by cwd/lane and by resume key, with collapse and order keys;
   - issues by parent, by repo, by `worktreePath` and by `startedBySession`, plus proposed issues;
   - counts.

   These answer "is X cold by rule" and "which cold ids satisfy Q" without the pool.
2. **Attach = candidate-resident rows only.** `snapshot` enumerates the candidate set, and `reseed` places those rows. Cold rows are never registered at attach. Being cold becomes "known to the row source and not resident". `residency.isCold`/`known`/`summary` ask the row source for unregistered ids, through the single reader (`RowSource.row`, then the declared summary projected on read).
3. **Relations with lazy cold members.** A hot target's bucket is seeded with its cold members from the row-source index the first time it is observed (`promote`-style, counted). A cold source's links are filed when the row is first asked for. The derivations' reads stay the same; maintenance then follows feed events as today.
4. **Enumerating readers move to indexed queries.** Catalog, inbox screening, prefixes, settings, header occupancy and reclaim, issue-page lists, board, shell and mission catalog get a declared query, answered from the row-source index plus resident rows. The chat-context scans are POD-4286's separate issue. A reader that truly needs every summary (the board's text filter) pays it when mounted, never at attach.
5. **Gate contract restated.**
   - Every feed row is resident XOR cold-by-rule, judged against the row source's index rather than the pool's registry.
   - `ids()` becomes the cold rows the pool has seen; the census of cold-by-rule rows stays equal.
   - `diffRelations` compares `many`/`subset` after observation, which forces the lazy seeding.

   Plants:
   - an all-rows reseed must fail an attach-size counter (`rowsPlaced` ≤ candidate-resident);
   - a reader that enumerates all cold ids must fail a scan counter;
   - a lazy bucket that misses a cold member must fail `diffRelations`.

## Expected effect

Phone fixture: the attach pool work falls from about 330–440 ms to the row-source seed (about 40–80 ms) plus O(resident) placement (about 130 rows: issues 64 open, sessions 32 live, plus keepers). Heap falls with it (cold summaries, twins and atoms are no longer held for 11k rows). Web 4x (19k issues, 17k sessions) gains proportionally more. Screens that enumerate cold rows pay a query when mounted instead of the attach paying for everything.

## Proposed decomposition (sub-issues of POD-5391)

1. **Row-source cold indexes and candidate-resident partition**, with a from-scratch equality check against `coldByRule` over all rows, plus planted faults.
2. **Enumerating readers onto indexed queries**: the phone readers first (catalog, inbox, prefixes, settings, session-pane), then web (header, issue-page, shell, mission, board).
3. **Lazy residency and relations at attach, with the gate contract restated** (depends on 1 and 2). Includes the paired phone warm-start and web startup (`apps/web/harness/pool-memory.ts`) before/after.

Each is several days of work in shared core and is not a one-issue patch. Step 3 alone, without 1 and 2, would break the gate and move the cost to the work screen's mount.

## Step 3 as built (POD-5407)

Step 3 goes one step further than item 3 above. Seeding a hot bucket with copies of its cold members would leave a second, pool-side copy of the relations, and finding 14 of the architecture review (POD-5417) asks for one owner of these facts. So:

**One owner: the relation index.** The row source's cold index gains a plain relation index (`shared/relation-index.ts`). It runs the same declared maintenance the pool's engine ran (links, buckets, subsets, collapse, prefix roots with `alsoRoots`), over every row, once, outside the pool. The cold index's own lane seating and collapse groups are read from it, so it holds no second copy either. Each publication leaves a delta: the forward slots, buckets and subsets it moved, the collapse verdicts that flipped and the rows that appeared or left.

**The pool's relations become a view of it.** `PoolRelations` keeps its reader (`one`, `many`, `size`, `subset`, `isCollapsed`, `orderKey`) but stores nothing per row. A read reports one atom for the slot it reads (created on that read, dropped when unobserved), and returns the index's answer. The pool's action reports the atoms the delta names. A bucket therefore holds its hot and cold members with no seeding step and no copy. A slot nobody observes costs nothing.

**Residency keeps no registry.** A row is cold in the pool when the index knows it and the pool's tables do not hold it. `isCold`, `known` and `hidden` answer from that. `summary` answers the declared fields from the index: the index holds, per row, the rule's own inputs plus every summary field a pool declares (`createColdIndex(schema, summaries)`; a feed's `cold(summaries)` rebuilds its index once when a pool names fields it does not yet hold). A cold row's declared summary therefore never costs a row read and the row is never installed, as before this change (POD-4286's decision, 2026-10-04: the readers' load-free contract stands). A summary of fields the index does not hold is absent: the reader answers LOADING and the row comes in through one batched load (the cutoff rule; never a synchronous per-row read). A row that the index says is no longer cold by rule is installed from the publication at hand or queued for the load window, as today. The rows checked per publication are the publication's own rows, the owners its members keep, the owners at the lanes its sessions moved in or out of, the descendants of an issue whose `canShow` fields moved, and the `via` dependents of anything warmed. `ids()` lists the cold rows the pool has asked about since the last attach.

**Read cursors and deltas.** The read-state lane (`readCursor`) holds resident issues only. A cold issue's cursor is the `readAt` the cold index holds for it, tracked by its residency key. Base filled the lane for every issue at attach. The relation delta the pool publishes belongs to one publication: `changes(event)` answers the delta of the event the index applied, and nothing for an event that reached the pool without passing the index (a fixture applying straight to the pool).

**Attach places candidates only.** `reseed` puts the index's `residentCandidates` plus every worktree row. It reads each candidate once by id. A counter (`rowsPlaced`) records how many rows the attach placed.

**Roster and first task.** The sidebar roster files resident sessions only. The old roster kept a "may still show" summary for every history session and loaded the ones it could not rule out. On the 1x and 4x fixtures the pool sidebar equals the legacy one before any load and after settling (`sidebar-check.test.ts`), and no lane waits on history sessions any more. `hasFirstTask` reads a count the index keeps (issues not deleted), not a walk over every issue.

**The gate, restated.** The partition check judges every feed row against the index: resident, or cold by rule and not resident. `ids()` is a subset of the cold-by-rule rows, and the census of cold-by-rule rows equals the rule over whole tables. `diffRelations` reads the pool's view after observation, against the from-scratch scan. The planted mistakes are:
- an all-rows attach fails the `rowsPlaced` bound;
- an index that drops one cold member from a bucket fails `diffRelations`;
- a view that misses one delta fails the notification test.

**Open question 1 of the review: does this take cold ids out of `issue.sessions` and the seat list?** No. A session is cold only through its issue (`via`), so every session of an issue on screen is resident, ended ones included. The seat list holds that issue's whole session history before and after this change. Findings 8 and 11 need a per-session retention rule, which is POD-5423's question, not an attach change.

**Finding 16 (phone Work first paint waits on roll-up loads).** This is not part of the attach. The roll-ups wait for cold children, which stay cold before and after this change. It stays with its own issue.

## Step 3 results (POD-5407, flatblock, 2026-10-04)

Base `b4d0134f17`, change `605fdab49f`; the account-switch heap was re-measured with the dispose fix (below). Captures ran under the `bench:flatblock` lease in a quiet window, one arm after the other, starting only when load was below 6 and at least 8 GB of memory was free.

**What the attach builds (census, `tracking-counts.baseline.json`, 1x / 4x).**

| | before | after |
|---|---:|---:|
| attach row reads | 416,921 / 1,632,267 | 13,900 / 55,727 |
| distinct rows read | 22,835 / 91,251 | 6,680 / 27,033 |
| held map entries | 33,246 / 134,784 | 6,747 / 27,124 |
| observable set members | 18,221 / 73,915 | 15 / 27 |
| observable sets | 6,232 / 25,543 | 193 / 792 |
| atoms | 9,924 / 39,855 | 6,086 / 22,269 |

Computeds, reactions and first-paint reads are unchanged. The heap census (`cold-structures.test.ts`) finds no per-cold-row entries that follow the history. Ten times the history leaves the pool's cold-id entries within the base cell's bound.

**Phone warm start** (`expo-mobile-pool-start-profile`, durable barrier, traced, 2 rounds × 3 timed samples per arm, all warm, no bootstraps).

| | base | change |
|---|---|---|
| pool ON, ms | 1527, 1709, 1821, 1672, 1723, 1684 (median ≈1697) | 1603, 1453, 1410, 1583, 1236, 1388 (median ≈1432, −16 %) |
| pool OFF, ms (no pool; noise control) | 781, 791, 734, 956, 919, 759 | 1411, 993, 901, 934, 871, 899 |
| heap, pool ON | 73.5 MB | 65.6 MB |

Overlaps: POD-5439's compiler ran during base round 1, and POD-5438's runs (01:48:50–01:49:56 UTC) during change round 2. The OFF arm spread is that noise.

**Web pool startup and heap** (`pool-memory.ts --arms=pool`, 3 samples, median).

| cell | startup base | startup change | heap base | heap change |
|---|---:|---:|---:|---:|
| 1x | 3,635 ms | 2,887 ms | 108.5 MiB | 103.1 MiB |
| 4x | 12,293 ms | 10,865 ms | 385.8 MiB | 366.8 MiB |
| h10a1 | 14,105 ms (load ≈11) | 11,276 ms | 305.9 MiB | 271.6 MiB |

**Account switch** (`sidebar-acceptance.ts --phase=counts --scales=1x`, POD-5402's two cases, 3 samples per arm). The harness exits 1 in every arm when it reaches the removed legacy arm ("Mode guard RED"); the pool records are written before that.

| case | ready base | ready change | used heap base | used heap change (before fix) | used heap change (fixed) |
|---|---|---|---:|---:|---:|
| no rebuild | 2165, 1782, 1805 (median 1805 ms) | 1986, 1986, 1803 (median 1986 ms) | 150.2 MB | 153.3 MB | 142.4 MB |
| rebuild | 3366, 3005, 3000 (median 3005 ms) | 2876, 2879, 2873 (median 2876 ms) | 165.9 MB | 182.8 MB | 160.9 MB |

The first change captures found +16.9 MB after a rebuild switch. The retired generation's pool survives the switch (POD-5402's survivors, the same 9 and 18 parts in both arms). The disposed pool still pointed at the retired feed's cold index (`indexSeen`), which holds every row's relations. The base's disposed pool had emptied its own relation maps, so it stayed light. The fix: a disposed pool drops its cold index references. `cold-structures.test.ts` checks that the index is unreachable from a disposed pool, and fails with the two lines removed. The fixed-heap column is from three samples at load 7.6–13.7 (heap does not depend on load; their ready times do, so the ready columns are the quiet-window samples). The no-rebuild ready medians differ by 181 ms, but the samples overlap (1782–2165 vs 1803–1986); three samples cannot separate them. The rebuild switch is 130 ms faster in every sample.

**Structural meter (POD-5425 screen work, gating since POD-5466).** On this change rebased onto `db95c578dd`: 47 readers × 9 clicks/deltas × 2 scales, 1,603 counters, 365 expected failures, 0 unexpected (`bun run speed:structural`, 2026-10-04 04:28–04:34 UTC).
