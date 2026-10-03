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
