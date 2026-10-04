# POD-4286 epic review: the MobX pool rewrite, graded (POD-5510, 2026-10-04)

**What this is.** A read-only review of the whole POD-4286 epic as it stands on `integrate/4286-pilot` at
`dcceaacb1d` (dev/mw `334dbe7ce5` plus the day's landings), graded in three separate parts for the operator:
is the design architecturally correct, is it strictly better for Podium than the old client store, and is it
good MobX practice. The "before" is `5e3ece5cd6`, dev/mw on 2026-10-01, the last commit before
`@podium/client-graph` existed. Every `file:line` is at `dcceaacb1d` unless a commit is named.

**Method.** I read the design history (`docs/plans/pod-4286-frontend-store-performance.md`, the POD-5426
spec `docs/plans/pod-4286-optimism-and-refusals.md`, ADR 3 amendment 2, the POD-5417 review
`docs/reviews/pod-4286-mobx-architecture-review.md` and the round-three decision docs), every measurement
report under `docs/measurements/` that the epic produced, the live reports attached to POD-5501, POD-5509 and
POD-5487, and the epic's mail. Three read-only helper audits covered the pool core and seams, MobX usage in
the pool and both apps, and the before/after size and test census; I re-read the code behind every finding
that carries a grade. **No product code was changed and nothing was run.** Every number is RUN by another
lane and is labelled with its source; everything else is READ.

**Grades.**

| Part | Grade | One line |
|---|---|---|
| 1. Architectural correctness | **B−** | The decided design (one optimism owner, keyed inputs, one cold owner, declared questions) is built and holds. Marks come off for a feed that swallows errors, a dead "revert" mode, harness code imported by product, two extra write routes and ~2,500 lines of dead or duplicated seams. |
| 2. Strictly better than before | **C+** | 2–10x faster on the connected path and half the idle CPU; 1.5–4x slower on startup, issue page, group expand, palette, board and search; about 2x the retained heap. "Strictly better" is false today; "better where it set out to be, worse elsewhere, with the worse parts owned and shrinking" is true. |
| 3. MobX practice | **B−** | Shallow observables, rows by reference, disposers everywhere, per-field atoms and the hot paths the last review named are fixed. Marks come off for eight copies of a keyed-computed helper on MobX private APIs, structural equality as the default on 32 of 35 cached groups, five reactions that write state other computeds read, a 75-entry all-`false` `makeObservable`, and no production `configure()`. |

The ranked corrections are in the last section; each is filed as a sub-issue under POD-5076.

---

## Part 1 — Architectural correctness. Grade: **B−**

### 1.1 One mutation owner — holds for optimism, with two side doors and one dead door

The spec's decision (`pod-4286-optimism-and-refusals.md` §0) was: the pool owns optimism, the kernel
`Outbox` stays the one queue and durable record, the pool's log is an index over it. That is what shipped.

- The legacy ledger is gone. `packages/client-core/src/engine/optimism.ts`, `replica-binding.ts` and the
  snapshot publish were deleted in `15ed5c9ebd` (POD-5497). `OUTBOX_PARKED_YIELDS_PARTITION`,
  `yieldsWhenParked` and `parkedYieldsPartition` no longer exist anywhere (grep, positives only).
- One painter. `createPoolTransactions` (`packages/client-graph/src/write/transactions.ts:177`) does reduce,
  record, repaint and enqueue inside one `runInAction`, painting before the durable commit
  (`transactions.ts:678-728`) and unpainting on a failed enqueue (`:736-750`). Its `enqueue` port is bound once
  to the runtime outbox (`packages/client-graph/src/runtime-pool.ts:208`).
- One reducer set. The pure reducers moved out of the engine as the spec's step 3 asked
  (`packages/client-core/src/command-reducers.ts:347` `overlaysForOutboxEntry`); a test pins that the pool
  "reaches the reducers without importing an engine value" (`write/transactions.test.ts:58`).
- Engine actions write through the pool: `rt.write(kind, input)` (`packages/client-core/src/engine/actions.ts:1010-1052`)
  → `poolWriter.write` (`engine/runtime.ts:1653-1656`) → `PoolTransactions` → `EngineOutbox.enqueue`
  → kernel (`engine/kernel-outbox.ts:304`). Pool screens call `pool.mutate`/`pool.edit`, which delegate to the
  same log (`packages/client-graph/src/pool.ts:871-876, 909-914`). Nothing in `client-graph` writes a table
  outside `pool.apply` (`tables.*.set/delete` outside `pool.ts`: 0 hits).

What breaks the "one" in one mutation owner:

1. **Local-only kinds bypass the log.** `pinSet`, `tabSetOrder` and `settingsUpdatePersonal` go straight to
   `rt.outbox.enqueue` (`engine/actions.ts:554, 564, 1017, 1061`), as do `layoutSet`/`layoutClear`
   (`engine/replicated-layout.ts:297-298`) and chat sends (`engine/chat-send.ts:187`). The log adopts them
   afterwards through `ports.outbox.subscribe` (`transactions.ts:483-520, 642`), so there is one queue, but
   there are two enqueue routes and two paint rules (pool paint for issues and sessions, refetch for the
   rest, `runtime.ts:1484-1510`). The spec's section 5 wording change ("one queue and one durable record")
   describes this honestly; the plan's §4 rule still says "nothing new … queues commands" and has not been
   amended.
2. **A dormant second enqueue path ships in the product package.** `createWriteTransport`
   (`packages/client-graph/src/shared/receipts.ts:203, 216-219`) enqueues `issueUpdate`/`issueMarkRead`
   directly; its only callers are `packages/worklist-proto/shared/src/gen/write-oracle.ts:49` and
   `arm-edits.ts:43`. 244 lines of harness transport in the product package, beside the real one.
3. **The documented revert path is dead.** `host/pool-host.ts:36` says "`owns: []` is the ledger, the revert
   path", but the ledger is deleted and with no pool writer every write rejects with "Pool transactions are
   not attached" (`runtime.ts:1653-1656`). The row source's `truth` mode (`shared/row-source.ts:181`) is
   reachable only through that broken arm. A switch that cannot work is worse than no switch.

### 1.2 No lost semantics — present, with one half-ported seam

| Semantic | Where it lives now | Test |
|---|---|---|
| Optimistic paint before durable commit | `write/transactions.ts:688-728` | `write/spawns.test.ts:34`, `write/transactions.test.ts:92` |
| Rollback = rebase on refusal, announced after the action | `transactions.ts:574-595, 660` | `transactions.test.ts:92`; kernel R1 `client-core/src/engine/kernel-outbox.refusal-release.test.ts:118-168` |
| Refusal rule R1–R5 (ADR 3 amendment 2) | `packages/sync/src/outbox/outbox.ts:656-668, 793` | `kernel-outbox.refusal-release.test.ts` |
| Typed server refusals (spec step 0) | `apps/server/src/modules/issues/service/crud.ts:930, 1112, 1461, 1600, 1832, 1856` (`IssueRefusal`) | server lane |
| Atomic rescope | log settles an addressed batch in one action `transactions.ts:651-670`; `replace` in the row source | `client-core/src/replica/kernel/facade.test.ts:167`, `replica/feed/divergence-matrix.test.ts:380, 410` |
| Offline hydration | boot rebuild from `outbox.awaiting()` then `pending()` `transactions.ts:626-640` | `transactions.test.ts:71`, `write/not-saved.test.ts:37` |
| Principal isolation | one pool per runtime in a `WeakMap` `host/pool-host.ts:69-79`; `destroy()` disposes the writer `runtime.ts:1444-1445`; outbox refuses foreign `onBehalfOf` `sync/src/outbox/outbox.ts:531-533` | `kernel-outbox.adoption.test.ts:184`, `spawns.test.ts:102, 117` |
| Draft ledger | untouched, `client-core/src/drafts/draft-ledger.ts`; the pool gets a per-session `onDraft` event `chat-context-source.ts:43` | `draft-ledger.test.ts` |
| Adoption of other tabs' and legacy records (spec §4.6) | `transactions.ts:483-520` | `kernel-outbox.adoption.test.ts:136-210` |

**Half-ported: evict versus delete, and readmission, at the transaction level.** Nothing in `write/`
knows about residency (grep `evict|resident|readmi` in `transactions.ts`: a comment at `:10` and `absentRow`
`:298-326`). The row source paints pooled rows regardless of residency and residency decides placement in
`pool.apply`, so the behaviour exists by composition, but **no test in `write/*.test.ts` covers "an evicted
row with a pending transaction stays unpainted and paints again on readmission"**, which is exactly the
semantic the plan's §4 names. The kernel-level coverage (`client-core/src/replica/session-companions.test.ts:88`)
and the cold-index readmission tests (`shared/cold-index.test.ts:72`, `reader-queries.test.ts:37`) do not
exercise the log. The spec's step-4 differential test "against the ledger" was never possible once the ledger
was deleted in the same day; the log's own tests total 360 lines (`write/*.test.ts`) against 1,117 lines of
log code.

### 1.3 Boundaries — the right shape, held by convention rather than by fence

The layering as built is sync (`packages/sync`) → client-core replica, socket transport and sync stream →
`createRowSource` + `createEngineLocals` (`runtime-pool.ts:98-128`) → `MobxPool` (`create.ts:33-34`) →
screens through `PoolScreen` registrations (`apps/web/src/app/pool-screens.ts:15-45`).

Good:

- **No pool adapter subscribes to a whole publish any more.** `runtime.subscribe(` in `client-graph` non-test
  code: 0 (the last review counted 13). Adapters read keyed inputs (`engine/keyed-inputs.ts`: `onLocals`,
  `onList`, `onDraft`) in 12 files. This is the spec's step 7–9 done.
- **The cold rule has one owner.** `relations.ts` is 265 lines of atoms that answer through
  `index: () => RelationQueries` (`relations.ts:62, 95`); `residency.ts` holds no `coldForward`/`coldBuckets`
  (grep: none), only a `summaryMemo` (`residency.ts:154, 316-332`) and asks `ColdQueries` (`:101, 133`); rule
  rows and the relation index live once in `shared/cold-index.ts:1-72, 199`. The last review's finding 14
  (mirrored three times) is resolved.
- Screens do not write replica rows. `pool.apply` in apps is test support and replay only
  (`apps/web/src/test-support/pool-fixture.ts:150`, `features/superagent/operator-replay.ts:70`). The one
  product `replica.applySnapshot` is a demo seed (`apps/mobile/src/client/MobileClientProvider.tsx:365-366`).

Not good:

- **Network and timers inside the pool package.** `header-source.ts` runs tRPC queries from a reaction and from
  two `setInterval`s (`header-source.ts:85, 151, 175-188`), and swallows their failures with empty `catch {}`
  (`:92, :169`), so a permanently failing endpoint shows a stale reading forever. A data pool that polls the
  server is a transport concern in the wrong layer.
- **Product derivation imports a test oracle.** `mission-view.ts:3` imports `issueDisplayRef` from
  `@podium/client-graph/diagnostics/reference/issue-views`, whose header says "stateless fixture oracle for
  pool parity" (`diagnostics/reference/issue-views.ts:1`).
- **Perf instrumentation is wired into the product path.** `sidebar-perf.ts` (100 lines, monkey-patching
  `ComputedValue`'s prototype at `:21`) is wired at `runtime-pool.ts:18`; `measureHeader` at
  `header-views.ts:1`, `countIssueBoard` at `issue-board-source.ts:1`, `reportSidebarPool` at
  `host/pool-host.ts:3`.
- **No fence.** `scripts/check-boundaries.ts` has no `client-graph → client-core/engine` rule; the plan's
  "pool imports no engine class" guard is one unit test (`transactions.test.ts:58`). Today only three value
  imports from `/engine` exist (`navigation-provider.ts:1`, `chat-context-source.ts:2`, `navigation-screen.ts:1`)
  and the other 38 are types, so the boundary holds, but nothing stops the next one.
- **Apps still reach around the pool.** `apps/web` imports `@podium/client-core/replica` at 119 sites and
  `/engine` at 58 (unclassified type versus value). The pool is consumed through **78 distinct deep subpaths**
  (`package.json` exports `./*`, `./shared/*`, `./worklist/*`, `./write/*`, `./diagnostics/*`); `index.ts`
  exports 14 symbols. Five non-test app files import `@podium/client-graph/diagnostics/*`.

What remains in `client-core` is coherent as runtime + transport + pure values (engine 7,408, replica 5,652,
socket-transport 3,020, values 17,822 lines). The leftovers: `replica/legacy-snapshot.ts` (a fixture capture
module in product source, `:1-12`); `engine/overlay.test.ts` (776 lines testing a module that moved);
`store.ts` is only `shallowEqual` under the old name (`:1-2`, imported from 18 app files); and the old
worklist list builders in `values/compose/worklist/` (1,998 lines) are still shipped although `unifiedWorkList`,
`sidebarSections`, `groupUnifiedWorkRows` and `sortUnifiedWorkRows` have **zero product callers** (only
comments at `client-graph/src/shared/row-view.ts:496-534`, `worklist/groups.ts:8`, and a perf fixture at
`apps/web/src/perf/large-state.frontend-perf.tsx:3`). The row-level predicates in that directory
(`rowSessions`, `rowStatusLine`, `sessionRetainsWorklistRow`) are live and shared, which is right.

### 1.4 Is the pool's design coherent?

**Coherent, and better than any earlier round.** The pieces fit: tables hold borrowed rows by reference
(`tables.ts:110-117`); residency decides hot versus cold with the cold facts owned once (`cold-index.ts`);
declared questions (`shared/reader-questions.ts`, `reader-queries.ts`, `query-result.ts`) answer list and
count questions over cold rows without walking tables, with incremental results since POD-5454; keyed inputs
replace the whole publish; `PoolTransactions` folds pending changes into the table rows at write time so
readers see plain rows (`pool.ts:689-690`: "no read-time overlay, no Proxy and no per-read pending lookup").
The round-three lessons (`docs/decisions/pod-4545-round-three-mobx-lessons.md` §2–3: write a bucket where it
lives, filings not re-lists, pure combines, one cold rule) are visible in the code.

**Leftover pilot scaffolding, duplicate paths and dead seams**, each small, together about 2,500 lines:

| Item | Where | Lines |
|---|---|---|
| Dead revert mode `owns: []` | `host/pool-host.ts:36` vs `runtime.ts:1653-1656` | — |
| Harness-only write transport | `shared/receipts.ts:203-244` | 244 |
| `write-contract.ts` kept after its log moved to the harness (its own header says so, `:19-20`) | `shared/write-contract.ts` | 243 |
| 13 screen schema aggregates never read (`ISSUE_BOARD_SOURCE_SCHEMA`, `NOTICE_SCHEMA`, `MOBILE_*_SCHEMA`, `*_RELATIONS`…) plus ~40 other exports with zero callers | `*-schema.ts`, `views.ts`, `worklist/visible.ts`, `shared/row-view.ts`, `shared/repo-from-lane.ts` | ~1,000 |
| Old worklist list builders with zero product callers | `client-core/src/values/compose/worklist/{rows,folds,published}.ts` | ~1,000 of 1,998 |
| Perf instrumentation on the product path | `sidebar-perf.ts`, `header-views.ts:1`, `issue-board-source.ts:1`, `host/pool-host.ts:3` | ~150 |
| Oracle import in a product derivation | `mission-view.ts:3` | 1 |
| Demo replica seed in a product provider | `apps/mobile/src/client/MobileClientProvider.tsx:365-366` | — |

**Duplicate rules** (finding 23 of the last review, unchanged): the "finished" predicate `stage === 'done'`
appears at 21 sites in 12 files with three truthiness variants for `closedReason`: `Boolean(facts.closedReason)`
at `worklist/rollup.ts:540`, `issue-board-source.ts:204`, `header-views.ts:451`, `shared/reader-questions.ts:173`
versus `!= null` at `rollup.ts:430, 686, 733`, `worklist/visible.ts:273`, `seat-verdicts.ts:98, 268`,
`shared/schema.ts:625`, `reader-questions.ts:165`. An empty-string reason is "finished" in one and not the
other. No shared predicate is exported.

**Error handling** (finding 27, unchanged): the row feed swallows a listener's throw and continues
(`shared/row-source.ts:1070-1077`), and a throwing `coldIndex.apply` silently drops the index
(`:1061-1067`) with no log and no counter. Because the throw comes out of `pool.apply`'s single
`runInAction`, MobX has already committed the table writes made before it, so every later event lands on a
partly applied pool with nothing to say so. On a pool that is the whole app's state, this is a silent stale
screen.

**Hand-maintained mirrors that could drift:** the sorted seat mirror in a closure, kept in step with the
relation index by hand and flagged "closures stay a review item" (`pool.ts:301-302, 390-409`); three
independent inverse-bucket maintainers outside the generic relation index (`automation-source.ts:65-72`,
`header-entities.ts:35-41`, `superagent.ts:147-148`) plus a third copy of session→issue ownership in the row
source (`shared/row-source.ts:480-500`); residency's six bookkeeping maps settled by a multi-phase loop
(`residency.ts:560-600`). Each is correct as far as reading shows; each is a bug waiting for the next edit.

**Why B− and not lower.** The design decisions the epic made are the right ones for Podium's shape (all data
local, incremental changes, one queue), they are written down, and the code follows them. The marks come off
for the seams: an error path that hides, a revert that cannot revert, a product derivation that depends on a
test oracle, and a long tail of dead exports that the plan's own F4 ("pilot scaffolding removal") was supposed
to delete.

---

## Part 2 — Strictly better for Podium than before? Grade: **C+**

**The one-line answer.** For the actions the epic set out to fix (switching sessions, issues and missions,
marking read, renaming, dragging, and the cost of a live update arriving) the new client is between 2x and
10x faster and uses about half the idle CPU. For everything it did not set out to fix (cold and warm start,
opening the issue page, expanding a project group, the palette, the board, search, typing) it is slower, in
places by 2x to 4x, and it holds roughly twice the retained heap. "Strictly better" is therefore **false**
today. "Better where it matters most, worse everywhere else, with the worse parts owned and shrinking" is the
honest reading. The grade is C+ because the regressions are measured, owned and shrinking, not because they
are small.

### 2.1 Speed, old versus new, same corpus, same box

Source: `docs/measurements/POD-4286-old-vs-new.md` (POD-5501, still in progress; web only). OLD =
`5e3ece5cd6`, NEW = `1aa0ec71f6` (dev/mw as the operator ran it on 2026-10-04, before POD-5497's deletion).
Matched ABAB rounds on flatblock, n=16 per action (startups n=8), seed 4443, 1x = 4,867 issues, 4x = 19,468
issues. Click-to-paint medians, ms.

| Action | 1x OLD → NEW | 4x OLD → NEW | Verdict |
|---|---:|---:|---|
| session switch | 791 → 418 | 5,618 → 920 | faster (−47 % / −84 %) |
| mark read | 954 → 128 | 7,548 → 1,323 | faster (−87 % / −82 %) |
| issue rename | 238 → 58 | 2,189 → 221 | faster (−76 % / −90 %) |
| mission switch | 408 → 223 | 2,501 → 730 | faster (−45 % / −71 %) |
| sidebar select | 298 → 149 | 2,093 → 496 | faster (−50 % / −76 %) |
| sidebar drag-drop | 247 → 112 | 1,763 → 396 | faster |
| large mission switch | 735 → 803 | 3,664 → 1,524 | no gain at 1x, −58 % at 4x |
| **app cold start** | **2,268 → 3,585** | **7,744 → 12,447** | **slower (+58 % / +61 %)** |
| **app warm start** | **1,173 → 2,185** | **4,407 → 9,276** | **slower (+86 % / +111 %)** |
| **issue page open** | **109 → 236** | **361 → 1,443** | **slower (+115 % / +299 %)** |
| **sidebar group expand** | **91 → 204** | **236 → 594** | **slower (+123 % / +152 %)** |
| command palette | 105 → 155 | 305 → 462 | slower (+47 % / +51 %) |
| board open | 329 → 392 | 648 → 1,099 | slower |
| board search | 58 → 120 | 158 → 293 | slower (about 2x) |
| issue-picker search | 24 → 30 | 45 → 81 | slower |
| sidebar collapse / expand | 88 → 101 / 171 → 192 | 309 → 402 / 759 → 1,005 | slower (+12–32 %) |
| superagent composer typing | 13.6 → 14.4 | 27.2 → 30.2 | equal at 1x, worse tail at 4x |
| dock open / close, header menu, flight-deck fold | within noise | mixed | equal |

Main-thread CPU per action follows the same split (same report, "Main-thread work per action"): cold start
6,041 → 10,536 ms at 4x, issue page 316 → 1,387 ms, palette 294 → 420 ms; session switch 5,476 → 714 ms,
mark-read 7,496 → 1,217 ms.

**Background cost is the clearest win.** Same report, 4x, 60-second windows at the recorded September-18
publication rates: one-core CPU **47.2 % → 28.0 %** (−41 %); under a busy profile with two output frames per
second **91.3 % → 44.2 %** (−52 %). Per update at 4x: a quiet window 1,189 → 29 ms (−97 %), a heartbeat
1,300 → 596 ms (−54 %), an issue change 1,456 → 276 ms (−81 %), but a session-output frame 40 → 60 ms (+50 %).
A heartbeat still costing 596 ms of main-thread time at 4x is not "incremental"; it is the ancestor
re-derivation and whole-pane structural compares of Part 3, and it is the largest remaining background defect.

**What the comparison cannot say.** The phone has no OLD arm: OLD crashes on the shared corpus with React
error 185 at both scales (POD-5505), so every phone claim is NEW-only. Session Chat composer typing could not
be measured in either arm. The comparison is of two shipped revisions three days apart, so other changes ride
along; it does not isolate MobX. flatblock ran at load 11–15 during the 4x rounds (the report says so);
renderer-thread CPU is recorded separately and confirms the direction of every headline regression.

### 2.2 The regressions the brief names, with their causes

- **Cold and warm start (+58 % / +86 % at 1x, +61 % / +111 % at 4x).** The pool builds every resident
  model's bookkeeping at attach: the memory breakdown (`docs/measurements/POD-pool-memory-breakdown.md`, T2)
  shows per-row MobX objects for 4,746 resident rows at 1x whether or not a screen shows them, and the mobile
  attach builds every source eagerly in series (13 `await`s in `apps/mobile/src/client/mobile-pool.ts:60-140`).
  POD-5403 removed one duplicate delivery of 5,200 session read states (74 ms web / 181 ms phone), which shows
  the shape of the remaining cost: whole-corpus passes at boot. **No lane owns startup today.**
- **Issue page open (+115 % at 1x, +299 % at 4x).** POD-5509's live reference-host report (artifact 3) shows
  1,117,936 session row reads across eight page opens before its fix and 0 after, and the board-card
  issue-page-open median falling 796 → 553 ms on live data. POD-5497 traced the page rebuilding "the global
  worktree path array" and re-reading an unchanged roster on every read-cursor paint (epic mail, 2026-10-04
  13:41). The POD-5501 numbers predate both fixes; the page is still about 2x the old one on live data after
  them.
- **Sidebar group expand (+123 % / +152 %).** POD-5514 measured 208 ms against OLD's 101 at 1x
  (mail 2026-10-04 16:03) and attributes it to remounted group row observers and visited-group DOM retention;
  after the indexed-activity and lazy-menu landings it is 186 ms, still slower than OLD.
- **Typing.** The superagent composer equals OLD at 1x and has a worse tail at 4x (p95 35.1 → 55.1 ms). The
  session Chat composer was measured on live data by POD-5506 (`docs/measurements/POD-5506-chat-composer.md`):
  three keystroke amplifiers, two of them in the pool path (the deferred pool draft mirror forcing a
  controlled-value restore, 120 value rewrites per 60 keys; the conversation projection re-publishing on
  every edit); p95 complete-frame 68 → 32 ms after ablation; the 16 ms target is not established. Typing was
  never a win of this epic and the pool added one amplifier to it.
- **Sidebar issue switch on live data (POD-5509).** Target: p95 under 100 ms. Live baseline on `1aa0ec71f6`
  (artifact 1): first-visit content paint **median 654 ms, p95 10,791 ms**; revisit median 430 ms, p95
  2,419 ms; input delay alone median 31 ms, p95 546 ms. Pool and derived reads are 28 % of sampled time, and
  the single largest leaf is `ReaderQueries.activity`'s `roots.some` callback at 8.1 %
  (`packages/client-graph/src/reader-queries.ts:355`), a scan of every resident session per repository
  activity question. After two fixes (indexed resident activity and lazy closed menus; reference host on
  demand) the paired live numbers are first visit 807 → 386 ms median and revisit 520 → 407 ms (artifact 3),
  with the cold maximum regressing 2,576 → 4,037 ms. **The target is unmet by 4x on the median and 40x on the
  tail.** The remaining slowest click spends 27 % in pool and reader work, 24 % in style, layout and paint,
  and 18 % in React render. Two of the three causes fixed so far were the same shape: an always-mounted
  component holding a whole-list reader for an event-time lookup — the last review's finding 7, which had
  "no owner" on 2026-10-03.

### 2.3 Memory

Source: `docs/measurements/POD-pool-memory-breakdown.md` (POD-5133, sidebar-only fixture, V8 used heap after
GC, medians of 5): legacy **29.8 → pool 63.4 MiB at 1x (+113 %)**, 91.3 → 213.9 at 4x (+134 %), 100.4 → 173.3
at 10x history. 87–93 % of the difference is MobX bookkeeping, **6.4–7.2 KB per resident row**: one computed
per issue per model field (`cached.ts`, 2.6 KB/row), a tracking entry per `ObservableMap` key looked up
(1.1 KB/row), boxed map entries, relation buckets, debug-name strings (0.5 KB/row), one filing reaction per
issue. The report's projected pool-only end state was +96 % / +112 % / +43 %; the epic budget is ≤ +10 %.

Since then: POD-5497's deletion saved **1.06 MiB at 1x and 3.09 MiB at 4x** (0.96 % / 0.78 %; mail
2026-10-04 15:09) — the legacy store was never where the memory went. POD-5487 found a +15 / +58 MiB rise
from three reader-index landings (eager title trigrams for a phone picker nobody had opened); POD-5500
recovered 13.0 / 51.2 MiB of it. The phone-side probe measured 110.6 → 109.5 MiB at 1x after the deletion
(a different fixture from the 63.4 figure; do not subtract across fixtures). **The ≤ 10 % budget is unmet and
no lane owns it**; the memory report's own step-2 list (plain per-row indexes, computeds only for rows on
screen, no debug names in production) is the plan and it has not been scheduled. One live symptom is open:
the iOS mission view is killed and reloaded every few seconds (POD-5517, 664 MB on a small chat, memory
suspected).

### 2.4 Correctness risk

Lower than before in two places and higher in three.

Lower: optimism has one rule for refusals (R1, ADR 3 amendment 2) and one fold (`PoolTransactions`) where the
old client had the ledger plus a chat-send special case; the server answers preconditions with a typed
`IssueRefusal` (`apps/server/src/modules/issues/service/crud.ts:930, 1112, 1461, 1600`), so a refused rename
no longer holds a partition for 14 days. The kernel-outbox contract tests grew to cover adoption, refusal
release, supersede and verdict durability (`packages/client-core/src/engine/kernel-outbox.*.test.ts`).

Higher: (1) the feed swallows a listener's or the cold index's throw silently (`shared/row-source.ts:1061-1077`);
(2) 23 `untracked(` reads and 7 `'peek'` reads rest on invariants written only in `clock.ts`'s inventory,
which lists 7 classes and is checked by no test; (3) the pool's write log has 360 lines of direct tests for
1,117 lines of code and no differential test against the deleted ledger, so settlement rules (echo coverage,
spawn grace, chained entries) are pinned by behaviour tests in client-core rather than by a parity oracle;
and the parity oracle that does exist (`client-graph/diagnostics/reference-state.ts:15`) is a re-implementation
of the old snapshot shape over `@podium/client-core/engine`, not the deleted store itself.

### 2.5 Code size, complexity, testability, maintainability

| Tree | BEFORE non-test (files) | BEFORE test | AFTER non-test (files) | AFTER test |
|---|---:|---:|---:|---:|
| `packages/client-core/src` | 48,406 (178) | 46,653 | 50,056 (203) | 44,143 |
| `packages/client-graph/src` | — | — | 29,781 (114) | 7,466 |
| `packages/client-graph/diagnostics` | — | — | 4,872 (43) | 101 |
| `apps/web/src` | 119,729 (543) | 85,864 | 121,829 (607) | 97,176 |
| `apps/mobile/src` | 49,148 (255) | 22,421 | 48,282 (276) | 31,060 |
| **client total (core + graph + web + mobile)** | **217,283** | **154,938** | **254,820 (+17 %)** | **179,946 (+16 %)** |
| `packages/worklist-proto` (harness, existed before) | 52,076 | 42,274 | 43,270 | 49,485 |

The old store (store, runtime publish, view-model slices, optimism ledger, replica binding) is deleted, yet
client-core **grew** by 1,600 lines: `viewmodels/` was renamed to `values/` in `15ed5c9ebd` (git shows
`{viewmodels => values}` with 0–4 line deltas; `values/compose/worklist/rows.ts` 478 vs 480), and
`accounts/` (1,671), `replica-assembly/` (1,231), `command-reducers.ts` (941) and `keyed-inputs.ts` (212)
landed in the same window. The client ships **37,500 more product lines** than before for the same screens.
What replaced what: `optimism.ts` + `overlay.ts` (1,786) → `write/*` + `write-contract` + `overlay-row`
(1,405); `replica-binding` + the snapshot publish → `row-source` + `source-registry` + `runtime-pool` (1,744);
`slices/worklist` (2,470) → `worklist/*` (4,934, twice the size); `viewmodels/mission.ts` (2,614) →
`mission-view.ts` (1,158) **plus** `values/mission.ts` (2,633) still shipped and imported for its predicates.
New work with no "before": residency, cold index, relation index, deadline clock, declared questions, 19
per-screen schema files, 4,872 lines of diagnostics.

**Complexity.** Adding a session field to a sidebar row: before, 8 hops in one abstraction family (a fold over
a snapshot: `replica/contract.ts` → `replica-binding.ts` → `runtime.ts` → `slices/worklist/published.ts` →
`rows.ts:109` → `use-unified-work.ts:131` → `SidebarUnified.tsx`); after, 9 hops across five families
(schema declaration `shared/schema.ts:1044` and `COLD_SESSION_FIELDS` `:708`, the per-screen summary lists in
**10 schema files**, the source adapter `shared/row-source.ts:491`, tables/models, the keyed view
`worklist/sidebar.ts:162` and `sidebar-row.ts`, the observer `react/row.tsx`, the hook
`features/worklist/pool-sidebar.tsx:128`). A field missing from one summary list fails soft at runtime
(`mission-view.ts:266` `Object.hasOwn` fallback, `session-seats.ts:95`), not at compile time. The pool is
imported through 78 subpaths; `@podium/client-core` imports in `apps/web` rose 223 → 271 files.

**Testability.** Test lines in the product packages fell by 2,500 while product lines rose by 37,500. The pool
package's in-place ratio is **0.25** (7,466 test lines for 29,781) against client-core's 0.88 before; it has
no `test` script of its own (`packages/client-graph/package.json`), so its 44 in-package tests run only
through the root vitest config. The compensation is the harness: 12,294 test lines under
`worklist-proto/arms/mobx/pool/**` and 15,885 under `harness/src/**` (work meters, frozen census, oracle
gates), plus 11 parity tests in the apps. These are thorough and they are the reason the structural
regressions of the last week were caught, but they live outside the package, 26 product test files import the
harness (13 web, 9 mobile, 4 client-graph), and **`speed:gate`, `speed:structural` and the oracle run are not
in CI** (`.github/workflows/ci.yml:412-415` calls CI "the BACKSTOP"; `docs/agents/testing.md:67-74` makes them
operator-run on flatblock). 106 app test files still mock `useReplicaIssues`/`useStore`/`getSnapshot` from a
module that no longer exports them.

**Maintainability.** The cut-over is complete: `useLegacy*` 0, `*-data-layer.ts` 0, switches 0, no legacy
arm a user can reach. 59 "legacy" parity notes remain in `client-graph` comments (e.g. `mission-view.ts:557,
699, 852`). The property that matters more than line count is real: a screen reads addressed rows and declared
questions, and a change to one row wakes one row's readers. That is what the old store could not have and it
is why the connected-path numbers in 2.1 moved. Against it: 15 hand-written `*-source.ts` adapters following
two copied templates, 19 schema files of which 13 aggregates are never read, and MobX primitives used directly
at 300+ sites (`runInAction` 111, `observable.` 59, `computed(` 51, `untracked(` 23, `_isComputingDerivation` 28).

### 2.6 Verdict on "strictly better"

| Dimension | Verdict |
|---|---|
| Connected-path speed (session/issue/mission switch, mark read, rename, drag) | **Better**, 2–10x |
| Live-update and idle CPU | **Better**, about half |
| Startup, issue page, group expand, palette, board, search | **Worse**, 1.5–4x; issue page and group expand owned by POD-5509/5514, **startup unowned** |
| Typing | **Equal** on the superagent composer; the chat composer gained one pool amplifier, now being removed |
| Retained memory | **Worse**, about 2x; the ≤ 10 % budget is unmet and unscheduled |
| Correctness risk | **Mixed**: simpler optimism rule; swallowed feed errors; untracked invariants unchecked |
| Code size | **Worse**: +37,500 product lines |
| Testability | **Mixed**: strong gates, outside the package and outside CI |
| Maintainability | **Better** where the design holds (addressed reads), **worse** in the adapter sprawl |

The epic's own budgets (plan §5): idle publishes — met by construction (no snapshot publish exists);
unrelated session delta zero worklist derivations — not met (a heartbeat still costs 596 ms at 4x); warm
switch p95 ≤ 100 ms — **not met** (live p95 is seconds); state/derive CPU p95 ≤ 8 ms — not met; ≤ 10 %
startup and memory regression — **not met by a wide margin**.

---

## Part 3 — MobX practice. Grade: **B−**

Compared against idiomatic MobX 6/7 (derive with `computed`, react only for effects, keep observables
minimal and shallow, `observer` at the leaves, avoid structural equality on large results, never use private
APIs) and Linear's sync-engine shape (one model object per entity, observable properties on access, views over
models, transactions for optimism). `mobx 7.0.3` and `mobx-react-lite 5.0.3` are pinned
(`packages/client-graph/package.json:65-66`); the apps import both only through
`packages/client-graph/src/react/index.ts:1-2`.

### 3.1 What the last review found, and where it stands

| # | Finding on 2026-10-03 | Now |
|---|---|---|
| 1 | Coarse `shellWindow`/header `window`/`mobileSessionWindow` rows | **Fixed.** Per-field atoms via `createFieldInputs` (`shared/field-inputs.ts:17-52`): one atom per key, created on tracked read, dropped when unobserved; `shell-source.ts:29-36`, `header-source.ts:57-63`, `mobile-session-context.ts:103-109`. `commandWindow` still declares 8 fields in one row (`command-launch-schema.ts:23`) but its readers subscribe per field. |
| 2 | Mission pane keyed by selected issue; memos pinned by no-op reactions | **Fixed.** Pane cached per mission root and mode (`mission-view.ts:191-201`); `mission.ts` uses `cachedKey`, released when unobserved (`mission.ts:31-35, 113`); `reaction(() => x.get(), () => {})`: 0 hits. |
| 6 | Overlay Proxy, fresh identity per read | **Half-fixed.** No Proxy; a frozen shallow copy memoised in `WeakMap<row, WeakMap<overrides, copy>>` (`shared/overlay-row.ts:5-43`). But all callers pass a **fresh `overrides` literal** (`models.ts:658-666`, `worklist/sidebar.ts:157-159`, `mission-view.ts:214, 411`), so the second level never hits across recomputes and every recompute still yields a new identity, forcing structural fallbacks downstream. |
| 8 | One filing reaction per in-memory issue, mounted or not | **Changed.** Reactions start on a demand atom's `onBecomeObserved`/`hold()` and stop at `settleIdle()` when no reader and no hold remain (`worklist/visible.ts:1379-1387, 1437-1444, 1484-1502`). Still a reaction that writes lanes other computeds read, and still two jobs in one (`visible.ts:1508-1538`). |
| 9 | Heartbeat re-derives ancestors over arrays of row objects | **Fixed.** Aggregates carry `sessionIds` (`worklist/rollup.ts:270, 364-371, 398`); `activity` split from `attention` (`models.ts:547-554`); `sameSidebar` compares seats by identity (`models.ts:450-459`). |
| 15 | Projection deep-compares every reader | **Changed.** Default equals is `Object.is` (`runtime-pool.ts:28, 124`). Still re-reads synchronously inside the Reaction on every invalidation (`:139-170`). |
| 18 | `computedFn` hand-written 7x on private API | **Worse: 8 copies plus 3 in `cached.ts`.** `cached.ts:78, 99-102` (`_isComputingDerivation`, `_getGlobalState`), `settings-views.ts:14`, `automation-views.ts:21`, `issue-page.ts:64`, `header-views.ts:57`, `issue-board-source.ts:101`, `mobile-screens.ts:73`, `shell-views.ts:31-39` (no derivation guard and **no `onBecomeUnobserved`**). 28 `_isComputingDerivation` references in 14 files. |
| 20 | Pool class with 64 `false` annotations | **Worse.** `makeObservable(this, {...})` on `MobxPool` lists **75** members, all `false` (`pool.ts:558-665`); `VisibleCollection` likewise (`worklist/visible.ts:1392-1415`). Real annotations exist only in `worklist/groups.ts:233-245, 367-380`. |
| 22 | Untracked-read inventory incomplete | **Still true.** Inventory has 7 items (`clock.ts:24-59`); 23 `untracked(` sites exist. Unlisted: `command-launch-views.ts:90, 118, 372`, `reader-queries.ts:68, 278-279`, `models.ts:939, 986`, `pool.ts:482-483`, `header-sessions.ts:56-91`, `query-result.ts:343`. `selectionEvicted()` still mutates during an observer render (`worklist/sidebar.ts:108-116`, called at `apps/web/src/features/worklist/pool-sidebar.tsx:141`); `MobileWork.sections()` still prunes plain maps inside a computed (`worklist/mobile.ts:192-194`). |
| 25 | Five React idioms; hooks reactive only inside observer | **Partly true.** `observer` (21 web, 0 mobile); `usePoolProjection` (93 web sites, all of mobile); projection-returns-store plus a second `useSyncExternalStore` (`apps/web/src/features/issues/board-pool-projection.ts:15-19`); imperative `createPoolProjection().subscribe` (`IssueChipLiveness.tsx:27-38`, `pane-reference-stages.ts:25-31`); `useMemo(() => computed(...)).get()` inside observers (`pool-sidebar.tsx:155, 252, 802, 893, 905`, `FlightDeckPool.tsx:73`). `shell-data.ts:62-105` hooks read the pool bare and are reactive only because all five callers happen to be observers; no dev assertion. |

Resolved outright since the last review: findings 1, 2, 9, 13 (whole-kind publish), 14 (cold rule mirrors),
19 (two optimism systems), 26 (switches and twins).

### 3.2 Observable granularity — **good**

All state is shallow: 36 `observable.map`, 15 `observable.box`, 2 `observable.array`, 1 `observable.ref`,
every map and array with `deep: false` (23 files). Tables store server rows **by reference** in shallow maps
(`tables.ts:110-117`); `observable(` deep copies and `toJS(`: 0 each. Locals are per-field atoms
(`field-inputs.ts`), time is deadline atoms (`clock.ts:12-18, 65-69`), 11 `createAtom(` sites in all. This
matches Linear's "plain row, observable slot" and is the right granularity for a 20k-row pool. Row objects are
not frozen (only `ENTITIES` and sentinels are, `tables.ts:104`, `row-source.ts:1271`); immutability is by
convention.

### 3.3 Computed versus reaction — **two-phase propagation survives in 5 of 8 reactions**

Counts in `client-graph` non-test: `computed(` 51, `reaction(` 8, `new Reaction(` 2, `autorun(` 0, `when(` 0.
Every reaction, and whether it is an effect or a derivation in disguise:

| Site | Does | Verdict |
|---|---|---|
| `header-source.ts:175-180` | observes `working().length`, fires a tRPC query | effect, right shape (wrong layer, Part 1) |
| `issue-reference.ts:138-160` | per resident issue, derives a ref key and **writes** `resident`/`requests` maps that `references.read` computeds read | derivation written as a reaction |
| `issue-board-source.ts:260-279` | per tracked issue, derives index keys and **writes** `buckets` observable sets read by board computeds | derivation written as a reaction |
| `mobile-inbox-views.ts:201-207` | one-shot wait for a route to load, self-disposes | effect, fine (`when` would say it) |
| `issue-board-projection.ts:25-33` | feeds a `useSyncExternalStore` snapshot, `compareStructural` on a board model | bridge, structural compare on a model |
| `header-sessions.ts:69` | **one reaction per resident session**, writes `roster`/`aggregates` maps that `headerViews.working()/aggregate()` read (`header-views.ts:103-106`) | derivation as reaction; created on first header read, disposed only at pool dispose (`header-views.ts:52-54, 524`), never when the header unmounts |
| `header-sessions.ts:97` | same for cold "working" sessions with a deadline | same |
| `worklist/visible.ts:1508-1538` | per candidate issue, writes lanes and sidebar owner | derivation as reaction, gated by demand |
| `runtime-pool.ts:139` | `Reaction` for React and imperative projections | effect, fine |
| `query-result.ts:304-325` | one `Reaction` per row of a query result, structural compare, mutates a sorted list and fires atoms | derived list maintained imperatively |

MobX's guidance is that a reaction is for side effects and a computed is for derived values, because a reaction
that writes observables makes propagation two-phase: a computed changes, a reaction runs after the batch,
writes an observable, and another computed re-runs, with a window in which readers see the old filing. The
round-three lessons chose "filings, not re-lists" deliberately for the worklist (one reaction per node beats
re-sorting the world), and the demand gating now makes that reaction mount-scoped, which is defensible. The
other four (`issue-reference`, `issue-board-source`, both `header-sessions`) are plain indexes that a keyed
computed or `createTransformer`-style memo would maintain without a reaction. Manual version counters also
stand in for derivation in `seat-verdicts.ts:144-150, 300`, `reader-queries.ts:23, 186`,
`command-launch-views.ts:64, 107, 132` and `chat-context-source.ts:93-94` (a `keepAlive` computed bumped by a
version box, which is a hand-rolled `observable.box(ids)`).

### 3.4 Reactions with side effects outside MobX

Network from a reaction and two `setInterval`s in `header-source.ts:85, 151, 175-188` (cleared on dispose,
`:189-196`). 23 `queueMicrotask` sites defer `runInAction` publishes (`automation-source.ts:111`,
`session-exit-source.ts:47`, `source-registry.ts:110`, `superagent.ts:209`, `chat-context-source.ts:138`,
`settings-source.ts:90`, `mobile-settings.ts:90`); `setTimeout` in `residency.ts:122`,
`write/transactions.ts:133`, `write/spawns.ts:150`. `console.` and `fetch(`: 0 in the pool. Acceptable, apart
from the network polling's layer.

### 3.5 Observer boundaries and dereferencing in render — **mostly right, one unguarded idiom**

- The projection hook is well built: one `Reaction` per hook instance, the reader adopted through a ref
  without resubscribing, `useSyncExternalStore` underneath, disposed at zero listeners
  (`host/pool-host.ts:184-209`, `runtime-pool.ts:84-96, 139-176`). Default equality `Object.is`.
- Web uses `observer` at 21 sites and the projection hook at 93; mobile uses **no `observer` at all** and reads
  everything through `useMobilePoolProjection` (`apps/mobile/src/client/mobile-pool.ts:140`), which is a
  consistent choice (each hook is a selector with its own reaction) and sidesteps React Native observer
  pitfalls. The cost is that a screen with many projections pays one synchronous re-read per projection per
  batch instead of one render schedule, which is the shape behind finding 15's residue.
- `useMemo(() => computed(...), deps).get()` inside observers (`pool-sidebar.tsx:155, 252, 802, 893, 905`,
  `FlightDeckPool.tsx:73`) is correct only because the enclosing component is `observer`
  (`pool-sidebar.tsx:148, 787, 874`, `FlightDeckPool.tsx:41`).
- **Bare reads with no own subscription**: `apps/web/src/app/shell-data.ts:62-105` hooks call
  `shellViews(pool).chrome()` and friends; they are reactive only because every current caller
  (`AutoContinueDialog`, `ApprovalDialog`, `PodiumLinkHost`, `BrowserOpenOverlay`, `use-desktop-close-tab.ts:8`)
  is observer-wrapped. The first non-observer caller silently never updates. No dev assertion exists.
- Stale dereferencing outside render: none found. The five `useCallback` readers that touch pool rows are
  passed to projections (`board-pool-projection.ts:16`, `board-pool-row.tsx:12, 16`). `PoolEviction` reads in
  render and acts in `useEffect` (`pool-sidebar.tsx:139-146`), which is fine.
- Double subscription on the board: a projection returns a store that a second `useSyncExternalStore`
  subscribes to, with `compareStructural` on the board model in the inner reaction
  (`board-pool-projection.ts:15-19`, `issue-board-projection.ts:25-29`).

### 3.6 Comparers, actions, batching, strict mode, annotations

- **Structural equality is the default almost everywhere.** `compareStructural` 116 references in the pool;
  `cachedGroup` defaults to it (`cached.ts:42, 58, 72`) and 32 of 35 `cachedGroup` calls accept the default
  (the three exceptions: `models.ts:488 sameSidebar`, `:545 sameAttention`, `:1178 sameVerdict`). Groups that
  return arrays, sets or whole panes and are deep-compared on every recompute: `facts`, `members`, `presence`,
  `nesting`, `nested`, `nestBelow`, `unitsBelow`, `missionMemberIds`, `missionPaneRows`, `missionPaneCore`
  (`models.ts:490-575`, `mission-view.ts:133-172`); all 14 mobile-work computeds (`worklist/mobile.ts:91-153`);
  the whole launch and palette projections (`command-launch-views.ts:400-401`). MobX's own guidance is to
  use `comparer.structural` only for small values; a deep walk of a 300-row pane on every member heartbeat is
  the cost behind the 596 ms heartbeat in Part 2. `JSON.stringify` is used as equality at
  `shared/row-view.ts:366` and as memo keys at 23 sites (allocation per read, key-order sensitive).
- **Actions and batching: good.** `runInAction` 82 sites; feed ingest is one action (`pool.ts:1014-1017`);
  source publications wrap in `runInAction`; no observable write outside an action was found. MobX
  `transaction` is not used (the 70 hits are the write log's own term).
- **Strict mode: absent in production.** `configure(` is called only in two tests (`source-registry.test.ts:62`,
  `automation-source.test.ts:19`), so `enforceActions` is the default `"observed"` (warn only) and
  `computedRequiresReaction` is off outside tests. The `cached.ts:99-108` "silent full recompute outside a
  reaction" path therefore never warns in the app, and the mobile long-press class of defect (last review,
  finding 5) has no tripwire.
- **Annotations: ceremony without substance.** `MobxPool`'s `makeObservable` block has 75 `false` entries and
  zero real annotations (`pool.ts:558-665`); `VisibleCollection` the same (`visible.ts:1392-1415`). A class
  with no observable members should be a plain class; the block hides that and costs a `makeObservable` walk
  per pool. `keepAlive: true` is used once (`chat-context-source.ts:94`); `onBecomeUnobserved` 17 sites, all
  memo releases; `onBecomeObserved` 0 (demand uses atom callbacks instead, `visible.ts:1379-1387`).

### 3.7 Memory: disposers, leaks, keepAlive — **disciplined**

Every `reaction`/`Reaction` creation stores its disposer (9 of 9: `header-source.ts:174`,
`issue-reference.ts:160`, `issue-board-source.ts:280`, `mobile-inbox-views.ts:201`,
`issue-board-projection.ts:25`, `header-sessions.ts:69, 97`, `visible.ts:1487`, `query-result.ts:323`,
`runtime-pool.ts:139`). Every app hook that subscribes returns cleanup (`IssueChipLiveness.tsx:23-41`,
`pane-reference-stages.ts:46-50`, the projection hook's unsubscribe). Memo caches release through
`onBecomeUnobserved`. Grow-only structures are bounded: `MissionViewReader.nodes` holds one tiny handle per
visited id (`mission-view.ts:184-189, 503`); the `shell-views` memo map has fixed keys; the overlay cache is
`WeakMap`-keyed. The two leaks by design are `HeaderSessions`' per-session reactions living for the pool after
the header's first read (`header-views.ts:52-54, 524`) and the overlay memo misses (3.1, finding 6), which
allocate a frozen copy per recompute.

The retained-heap numbers in Part 2 are not leaks; they are the price of the chosen granularity: one computed
per model field per issue (`cached.ts`, 2.6 KB/row), a tracking entry per map key looked up, and
debug-name strings for every per-row computed (`debug-name.ts`, 0.5 KB/row) in production.

### 3.8 Anti-patterns

- **Private MobX API**: `_isComputingDerivation` 28 references in 14 files, `_getGlobalState` 2
  (`cached.ts:24-25, 102`), a prototype monkey-patch of `ComputedValue` (`sidebar-perf.ts:21`). These pin the
  package to MobX 7.0.x internals; a point release can break the pool.
- **Reading cached computeds outside a reactive context in hot paths**: by design in event handlers
  (`cached.ts:17-20, 50-52`, `mission.ts:34`), a silent full recompute in production (3.6).
- **Derived state stored as observables and written by reactions or version bumps**: 3.3.
- **Side effects inside derivations**: `selectionEvicted()` writes `seenSelected` during an observer render
  (`worklist/sidebar.ts:108-116`); `MobileWork.sections()` deletes from plain maps inside a computed
  (`worklist/mobile.ts:192-194`).
- **Deep observable copies**: none. `observable.array` spread per read at `mobile.ts:137-138` (`.slice()`),
  `header-entities.ts:17` (`[...keys()]`): minor.
- **`new Proxy`**: one, the lazy array view in `query-result.ts:165-200`, which detaches to a real array on
  write. Not an overlay; acceptable, but it is a second array semantics for readers to know about.

### 3.9 Against Linear's shape

| Aspect | Linear | Here |
|---|---|---|
| Model objects | one per entity, observable properties on access | one `IssueModel`/`SessionModel` per row on first access (`models.ts:479`), fields from the schema — **same** |
| Screen state | views and stores over models | sidebar and phone-work groups still on `IssueModel` (`models.ts:469-473`); screen indexes still constructed in `MobxPool` (`pool.ts:237-258`) — last review's finding 20, unchanged |
| Inputs | sync actions carry changed properties per model | rows by id plus keyed inputs for locals, lists and drafts — **same shape now** |
| Derived lists | computed and virtualised at render | filed by demand-gated reactions — defensible, different |
| Optimism | mutate model, record transaction, roll back on reject | `PoolTransactions` — **same** |
| Lazy data | partial bootstrap, lazy collections | residency plus declared questions over a cold index — **same idea**, with more machinery |

**Why B− and not higher.** The fundamentals are right and the specific hot-path defects named three days ago
are fixed. What stops it being a B+ is that the same three habits recur across the package: write a memo
helper by hand on private internals instead of one shared helper, default to deep equality instead of
identity, and maintain an index with a reaction instead of deriving it. Each is cheap to fix once and
expensive left as a pattern.

---

## Ranked corrections

Ten corrections, each one paragraph, ranked by what they buy the operator. Each is filed as a sub-issue under
POD-5076 (P4); the issue refs are in the table at the end. The two regressions already owned by live lanes
(issue page and group expand, POD-5509 and POD-5514) are not duplicated here.

1. **Startup builds only what the first screen shows.** Cold start is +58 % at 1x and +61 % at 4x, warm start
   +86 % / +111 % (Part 2.1), and no lane owns it. The cause is structural: the pool builds every resident
   row's model bookkeeping and seeds every source at attach, and the phone attaches its sources in series
   (`apps/mobile/src/client/mobile-pool.ts:60-140`, 13 awaits). Proposal: measure attach with the per-change
   meter's method (what is built before first paint, per source), make source attach lazy per screen
   (`pool.sources.ensure` on first read, which the registry already supports), defer per-row model creation
   until a row is read, and gate on the POD-5501 cold/warm-start pair returning to within 10 % of OLD at both
   scales. This is the single largest user-visible regression and the one the operator feels every morning.

2. **Pool memory within the ≤ 10 % budget.** Retained heap is about 2x the old client (Part 2.3), 87–93 % of it
   MobX bookkeeping at 6–7 KB per resident row, and the budget has no owner. Proposal: execute the memory
   report's own step-2 list in order of size — no computed objects for rows that no screen observes (keep plain
   indexes for off-screen rows and build `cachedGroup` computeds on first observed read only), drop debug-name
   strings in production builds (`debug-name.ts`, 0.5 KB/row), carry ids not boxed entries where a map's
   values are never observed individually — and gate on the existing `pool-memory` probe at 1x/4x/10x against
   the legacy medians recorded in `POD-pool-memory-breakdown.md` T1. Also check the iOS kill loop (POD-5517)
   against the same probe on the phone export.

3. **The feed reports and recovers from an apply error.** `shared/row-source.ts:1061-1077` swallows a
   listener's throw and a failing `coldIndex.apply`, leaving a partly applied pool with no log, counter or
   resync. Proposal: on a listener throw, record the error in a visible diagnostic counter, log once with the
   event kind, and mark the pool for a `replace` resync on the next flush; on a cold-index throw, reseed the
   index from the next snapshot explicitly rather than nulling it. Add a test that a throwing listener
   increments the counter and triggers the resync, planted red first. Same treatment for the empty `catch {}`
   around header polling (`header-source.ts:92, 169`).

4. **One keyed-computed helper on the public API, with identity equality.** Eight hand-written copies of
   `computedFn` plus the three in `cached.ts` sit on `_isComputingDerivation`/`_getGlobalState` (Part 3.1 #18),
   one copy never releases (`shell-views.ts:31-39`), and all default to `compareStructural`. Proposal: one
   `keyedComputed(name, fn, { equals = Object.is })` built on public `computed` + `onBecomeUnobserved`, with
   the "read outside a derivation" branch replaced by a tracked-context assertion in development; migrate the
   eight copies; make the overlay memo hit by giving each caller a stable overrides object per (row, value)
   pair (`models.ts:658-666`, `worklist/sidebar.ts:157-159`, `mission-view.ts:214, 411`) so downstream groups
   can compare by identity; then switch the 32 default-structural `cachedGroup` sites to identity or a
   field-wise comparer, starting with the whole-pane and mobile-work groups. Add a lint rule refusing `mobx`
   underscore imports outside the one helper.

5. **Derive indexes, do not react them.** Five reactions write observable state that other computeds read
   (`issue-reference.ts:138`, `issue-board-source.ts:260`, `header-sessions.ts:69, 97`, `visible.ts:1508`),
   plus manual version boxes in four files (Part 3.3). `HeaderSessions` keeps one reaction per resident session
   alive for the pool's lifetime after the header's first read. Proposal: turn the reference, board-key and
   header-session indexes into keyed computeds over the declared relation index (the pattern
   `PoolRelations` already uses), scope `HeaderSessions` to the header's mount with the same demand atom the
   worklist uses, and replace version boxes with observable collections. Keep the worklist filing reaction
   (it is the round-three decision and now demand-gated) but split sidebar-owner filing into its own computed.

6. **A heartbeat costs one row.** A session heartbeat at 4x still costs 596 ms of main thread (Part 2.1,
   POD-5501 background table), down from 1,300 but far from incremental. Proposal: profile one heartbeat with
   the per-change meter at 1x and 4x, then remove the remaining whole-subtree work it triggers: the
   deep-compared pane and attention groups (correction 4), any ancestor group that still copies session
   arrays, and the sidebar-roster `queueIssue` re-sync of cold seats on any issue record (last review's
   finding 11, `worklist/sidebar-roster.ts`). Gate: the meter's heartbeat row at 4x within 2x of 1x, and the
   POD-5501 heartbeat window under 100 ms.

7. **Finish the pilot removal (F4): delete the dead seams.** About 2,500 lines of scaffolding remain in product
   paths (Part 1.4): the `owns: []` revert mode that cannot work (`host/pool-host.ts:36`), the harness-only
   write transport (`shared/receipts.ts:203-244`), `shared/write-contract.ts`, 13 unread schema aggregates and
   ~40 zero-caller exports, the old list builders in `client-core/src/values/compose/worklist/`, the oracle
   import in `mission-view.ts:3`, perf instrumentation wired at `runtime-pool.ts:18` and three view files, the
   demo seed in `MobileClientProvider.tsx:365-366`, `replica/legacy-snapshot.ts`, and the 106 app test files
   that mock deleted store hooks. Proposal: one deletion lane with a zero-caller census as its gate (grep
   proves positives only, so run the full typecheck and the frozen census after each batch), moving anything
   the harness still needs into `worklist-proto`.

8. **One rule for "closed" and "finished".** `stage === 'done'` with three `closedReason` variants at 21
   sites in 12 files (Part 1.4) already disagree on an empty-string reason. Proposal: one `predicates.ts` in
   `shared/` exporting `isFinished`, `isClosed`, `isExcluded`, imported everywhere; a lint rule refusing literal
   `stage === 'done'` and `closedReason` checks outside it; and a test that the mission header's progress and
   the sidebar's progress agree on a corpus that contains empty-string reasons.

9. **One write path and a boundary fence.** Local-only kinds (`pinSet`, `tabSetOrder`,
   `settingsUpdatePersonal`, layout, chat sends) enqueue around the pool log and paint by refetch
   (`engine/actions.ts:554, 564, 1017, 1061`, `replicated-layout.ts:297-298`, `chat-send.ts:187`); the pool
   package polls the server from a reaction (`header-source.ts:85, 151, 175-188`); and no lint stops
   `client-graph` importing engine values or apps importing `diagnostics/*`. Proposal: route the local kinds
   through `rt.write` with reducers (or document them as non-optimistic and amend the plan's §4 rule as the
   spec's §5 asked), move quota and history polling into a runtime service that feeds the pool a keyed input,
   and add `client-graph → client-core/engine (values)` and `apps → client-graph/diagnostics` rules to
   `scripts/check-boundaries.ts`.

10. **Strict mode in development and an enforced untracked-read inventory.** Production never calls
    `configure()`, so silent full recomputes and side effects in derivations never warn; the inventory in
    `clock.ts:24-59` lists 7 of 23 `untracked(` sites; `selectionEvicted()` mutates during render and
    `MobileWork.sections()` prunes inside a computed (Part 3.8); `shell-data.ts` hooks are reactive only by
    luck of their callers. Proposal: `configure({ enforceActions: 'always', computedRequiresReaction: true,
    observableRequiresReaction: true })` in development builds of both apps, make eviction an action on the
    selection change and the mobile prune a reaction, add a dev assertion that `shell-data` hooks run inside an
    observer, and a lint rule that every `untracked(` and `'peek'` read carries an inventory tag with a test
    that the inventory lists every tag (the `no-table-walk` fence already polices table walks the same way).

| # | Correction | Sub-issue |
|---|---|---|
| 1 | Startup builds only the first screen | POD-5538 |
| 2 | Pool memory within budget | POD-5539 |
| 3 | Feed errors surface and resync | POD-5540 |
| 4 | One keyed-computed helper, identity equality | POD-5541 |
| 5 | Derive indexes, not react them | POD-5542 |
| 6 | A heartbeat costs one row | POD-5543 |
| 7 | Pilot scaffolding removal | POD-5544 |
| 8 | One closed-issue rule | POD-5545 |
| 9 | One write path and a boundary fence | POD-5546 |
| 10 | Strict mode and tracked-read guard | POD-5547 |

---

## Evidence index

- Design: `docs/plans/pod-4286-frontend-store-performance.md` (§1a–1c measured corrections, §4 rules, §5
  budgets); `docs/plans/pod-4286-optimism-and-refusals.md` (§0, §3 R1–R5, §4, §5, §6, §7);
  `docs/adr/0003-command-security-amendment-2.md`; `docs/reviews/pod-4286-mobx-architecture-review.md`
  (findings 1–29 at `ea5214c4c5`); `docs/decisions/pod-4545-round-three-mobx-lessons.md`.
- Measurements (all RUN by their lanes): `docs/measurements/POD-4286-baseline.md`, `POD-4286-gate-a.md`,
  `POD-5077-switch-baseline.md`, `POD-pool-memory-breakdown.md`, `POD-slow-client-after-update.md`,
  `pod-5428-render-cost.md`, `POD-5403-warm-cache-completeness.md`, `POD-5500-phone-search-memory.md`,
  `POD-5506-chat-composer.md`, `POD-4286-old-vs-new.md` (POD-5501, in progress), `click-speed-baseline.json`,
  `full-screen-click-profile.md`; POD-5487 artifact 1 (`pool-memory-attribution/report.md`); POD-5509
  artifacts 1–3 (live sidebar breakdown and two paired fixes); POD-5497 landing mail (2026-10-04 15:09).
- Code census: `wc -l` over `git ls-tree` at `5e3ece5cd6` and `dcceaacb1d`; counts include comments; test
  classification by path pattern.
