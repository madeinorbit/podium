# Round three MobX pool after the rework: pilot readiness review (2026-09-30)

**Question.** Should this MobX pool be the design we put into the real app as the opt-in pilot on the
worklist path (operator decision, 2026-09-30)? If not yet, what has to change first?

**Scope.** `packages/worklist-proto/arms/mobx/pool/` and its harness adapter
`packages/worklist-proto/harness/src/adapters/mobx-pool.ts` on `integrate/4545-round-three` @ `2d19cd60d`.
All `file:line` references are at that SHA. The branch was later rebased onto a newer dev/mw as
`e0b7b486c`; `git diff 2d19cd60d e0b7b486c -- packages/worklist-proto` is empty, so every reference
and run holds there too. Paths below are relative to `packages/worklist-proto/`
unless they start with `docs/` or `apps/`.

**Sources.**
- The earlier review: `docs/decisions/pod-4545-round-three-mobx-linear-review.md` (at `95ec37a7d`).
- The raw Linear talks: `~/Resources/LinearTalk/transcript_talk1.txt` and `transcript_talk2.txt`.
- The round-three design: POD-4545 and its contract issues (POD-4546 schema, POD-4547 row view,
  POD-4548 write contract, POD-4549 bubbling, POD-4608 locals); `docs/plans/pod-4441-harness.md`;
  `docs/decisions/4441-round-two-audit.md` §3, §5–7; `docs/plans/pod-4286-frontend-store-performance.md`
  (phases D–F).
- The rework issues and their reports: POD-4742 to POD-4749, POD-4753 to POD-4760, POD-4792 and POD-4825.
- The measurements: `docs/measurements/POD-4746.md`, `POD-4747.md`, `POD-4753.md`, `POD-4754.md`,
  `POD-4755-one-object.md`, `POD-4757-one-index.md` and `POD-4934.md`.

**What I ran.** Everything ran on flatblock, in `~/podium-test-4942`, with the node lane
(`bun run test:file`). All results are counts, not walls, because the box was loaded (load average
6–19) while four full-size gates ran next door. I did not re-run those gates; the coordinator
reports them.
- **Base, focused files.** `write/settle.test.tsx`, `write/reader.test.tsx`,
  `worklist/group-label.test.ts`, `worklist/scaling.test.ts`, `tracking-counts.test.ts`,
  `harness/src/cold-rule.test.ts` and `harness/src/work-per-change.test.tsx`. Results are in §4 and
  the appendix.
- **A new probe test.** `harness/review/post-rework-probes.test.ts`, committed with this review. It
  measures growth by axis, the idle case, the same change at history ×1 and ×10, and synchronous
  cold reads.
- **Four planted mistakes.** Each was backed up with `cp`, edited on flatblock, run, and restored
  with `cp`. The checkout was clean afterwards. Details are in the appendix.

Four read-only helpers checked the earlier review's items against the code. Every one of their
claims that this review relies on was either re-read at the cited line or executed. Where a claim
was only read, the text says **(read)**.

KNOWN, included without re-deriving:
- **POD-4940** is fixing a live-data parity gap. The MobX pool drops a done issue that is awaiting
  merge, because the fixture's awaiting-merge stamp was invisible to the oracle.
- **The live demo (POD-4537)** showed misleading counters, because the page itself snapshots the
  arm twice a second.

## Verdict

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Did the rework do what the review asked? | **Mostly, and the core of it is real.** Of 22 review items: **13 were fully met, 7 partly, and 2 not.** Six that matter were met in letter but not in intent (listed under the §1 table). The worst of these is **POD-4760**: the product entry points (`arm.ts`, `write/arm.ts`) are run by no test and no page. The harness copies `create()` instead of wrapping it. | §1; plant PL1 |
| 2 | Is it now built the way Linear builds its client? | **Yes, on the data layer, the objects and the write path. It deliberately diverges on the list.** There is one object per issue, cached values are built on first reactive read, relations are declared in the schema, navigation is typed, and optimism sits inside the one reader with model setters. Computeds per visible row fell from 122 to **19.6**, and reactions per visible row from 11.5 to **3.8**. The divergence: **one filing reaction per issue in memory** keeps the visible set and the groups incrementally, where Linear filters at render time. That was chosen on measurement (review §4.8). What is still missing is Linear's partial bootstrap: nothing is ever out of memory. | §2; `tracking-counts.baseline.json`; probe 1 |
| 3 | Are the round-three traps gone? | **Two are found, and I say so loudly.** First, **test-only code is still in product code**, under new names: the `outOfMemory`/`heldOut` test knob, a zero `stats` dummy, an unused `_reads` parameter, test accessors, gate functions in `enumerate.ts`, and the whole of `rebuild.ts`. Second, **a listener per entity**: one reaction per resident issue, including archived, deleted and hidden ones. Smaller findings: one relation is still kept by hand (the seat mirror keyed on the string `'issue.sessions'`); native passes whole lane arrays as props; the "finished" rule has 4 copies. There is no derivation that reads the whole corpus per change, and no MobX allowance. | §3 |
| 4a | Idle = zero work? | **Yes, measured.** After loads settle no timer is armed, and a clock advance that crosses no deadline runs 0 computeds and 0 reactions. The control run is live: a day's advance ran 68 computeds and 8 reactions. | probe 2 |
| 4b | An update costs only what it changes? | **Yes, up to the changed row's group.** Every one of the 16 scenarios passes 1x→4x, bare and with the write layer idle and pending. The same rename costs the same at history ×1 and ×10 (1 computed run each). But a row entering, leaving or moving copies its whole group lane: #6a new issue walks 498 elements at 1x and 1,719 at 4x. The check allows this by design. | base run; probe 3; PL3 |
| 4c | A local interaction is fast? | **By counts, yes.** A selection click is 2 derivations and an optimistic press is 0, flat across scales. **By walls, unmeasured since the rework.** The last browser matrix predates it (`d9a6be7c2`), and the browser's windowed list is never counted (PL2). | base run; PL2 |
| 4d | Hard to get wrong? | **Partly.** Tracking is automatic, strict flags plus a warning trap run in tests, and the one reader holds every read to one value (a bypass plant goes red). What can still go wrong silently: a new `peek` caller, an untracked plain read (the inventory is incomplete), the private MobX API in `cached.ts`, and the untested product entry point. | §4d; PL1, PL4 |
| 4e | Keeps working as data grows? | **Per change, yes. Memory and startup, no.** At history ×10, with the same 732 visible rows, the pool holds **2.2×** the resident issues (and filing reactions), **5×** the resident sessions, **3.5×** the map entries and **4.1×** the set members. Every unbound session and every archived or deleted open issue stays in memory, and the shared cold rule keeps 1,544 closed issues that never show. The browser heap has not been re-measured on the history axis since the rework; before it the heap grew 40 → 161 MB. | probe 1; `POD-4747.md` |
| 5 | Ready to pilot? | **Yes as the design, after four must-fixes.** POD-4940 must also land. The pool is the right shape for phases D–F. The seams are the per-row feed, the receipts and the locals, which today live in `shared/`, over client-core. | §5 |
| 6 | Biggest risk? | **Memory and startup grow with the operator's history**, which grows forever, while the memory cutoff is deferred. Second: **the paths the pilot would actually run** (the product entry point and write layer, the browser window, the native list) **are not the paths the instruments run.** | §6 |

## 1. Item by item

"Letter / intent" says whether the item did what was written, and whether it achieved what the item
was for. Item codes (C, H, I, A, P, M) are the earlier review's.

| Review item | Issue | Verdict | Letter / intent | Evidence and gap |
|---|---|---|---|---|
| C1 W10 expiry timer | POD-4742 | **Fully** | both | Timer in product: `write/edit.ts:107-110` (`realSchedule`), `:215-231` (armed at earliest receipt + TTL), cleared in `dispose` `:468-474`. Base run: 4 TTL cases green (`write/settle.test.tsx:492-548`). **Gap:** every test injects `schedule`; the default `setTimeout` path the product uses never runs in a test. |
| C2 + A4 one reader with edits | POD-4743 | **Fully** | both | One reader: `pool.ts:531-546`. The overlay reaches it through a seam passed at construction (`WriteSeam`, `pool.ts:167-172`), with no replaced input functions. Models, views and visibility all read through it (`models.ts:214-251`, `pool.ts:391-435`). Base run: `write/reader.test.tsx` green. PL4 (a part reading the table directly) turns it red. **Residual (read):** a hidden issue's summary holds `stage` (`worklist/visible.ts:219`), which the overlay does not cover. |
| H1 tracked group labels | POD-4744, in POD-4757 | **Partly** | letter yes, intent no | Label and fold order are now tracked (`worklist/groups.ts:245-258`); `group-label.test.ts` is green. The untracked-read inventory (`clock.ts:24-52`) is still incomplete: `relations.ts:446-454` reads the plain `extraCounts` map inside `one()`, which derivations reach (`worklist/visible.ts:436`); and `pool.ts:648` makes an `untracked(has)` read (both read). |
| C3 R3 in the cold rule | POD-4745 | **Fully** (letter), partly (intent) | letter yes, intent partly | `shared/src/schema.ts:757-775` (lane keeper), negative control `shared/src/schema.test.ts:855-863`. Base run: `cold-rule.test.ts` green. The corpus holds no row kept by R3 alone, and the hand arm has no live R3 test (read). The rule is now complete, but loose: at history ×10 it keeps 1,544 closed issues that never show (probe 1). |
| H2 closure prediction | POD-4757 | **Fully**, by removal | both | `plainScope`, `expandRoots` and `syncWorklist` are gone. Every issue in memory files itself (`pool.ts:510`, `:724-731`; `worklist/visible.ts:1081-1092`). |
| I1 scale-invariant work check | POD-4746 | **Partly** | letter yes, intent partly | `harness/src/scale-check.ts:147`, `work-per-change.test.tsx:201-284`. MobX has no allowance (`roster.ts:110-119`). Base run: green on 16 scenarios × 3 variants. **Gap:** the bound (the changed items' neighbourhood at 4x) includes the whole group a row enters or leaves, up to 2,843 of 2,928 visible rows on #8b. So per-change work of order "the group" passes (PL3), and the browser window path is never run (PL2). |
| I2 + I4 two-axis corpus, growth test | POD-4747 | **Fully** (instrument) | both | `harness/src/fixture/corpus.ts:82-99, :882`; `harness/browser/growth.ts`. **The MobX result is from before the rework** (`d9a6be7c2`): heap 40 → 161 MB and cold start 652 → 2,405 ms at history ×10. No browser growth matrix has been run since. Probe 1 gives the count proxy (§4e). |
| I3 construction count gate | POD-4748 | **Fully** | both | `tracking-counts.test.ts` fails on growth and on shrink. Base run: green. Objects on cold rows are gated only against the baseline, never required to be zero. |
| M4 delete round-two arm | POD-4749 | **Fully** | both | Deleted (`b7d0351d8`). One stale comment remains: `enforce.ts:15-17`. |
| A3 prep: loading-aware closed reads | POD-4753 | **Partly** | letter yes, intent partly | Hidden issues answer from a declared summary (`models.ts:429-433`), and startup reads no cold row by id (probe 4: 0 after create, 0 after paint). **But `peek` is still a synchronous read by id through the feed** (`pool.ts:541` → `residency.ts:522-524`). It is reached from 7 call sites in derivations, and **33 cold rows are read that way after the first window's loads** (probe 4, same at history ×1 and ×10). Under a real cutoff each of those is a blocking read of data not in memory (cutoff rule 4). |
| A3 aggregates over cold members | POD-4754 | **Fully** | both | `worklist/rollup.ts:699-720`: LOADING becomes a pending unit, and the family is loaded when the row is drawn. It loads whole rows where it needs two fields; a loaded row never goes cold again (`residency.ts:65-68`, read). |
| A1 + P3 one model per entity | POD-4755 | **Partly** (letter), fully (intent) | letter no, intent yes | One `IssueModel` (`models.ts:412`); `IssueNode` and `SessionNode` are gone. There are 34 cached values per issue, not 5–10, but each is built on first reactive read and dropped when unobserved (`cached.ts:38-67`). So construction builds 0, and first paint builds 19.6 per visible row (122 before). |
| (row fields) rows read the issue | POD-4756 | **Fully** (letter), partly (intent) | letter yes, intent partly | The row is an observer reading the issue (`react/row.tsx`, `react/list.tsx:87`). The capability limit is type-only: at runtime `row` is the whole model, and `host` is the pool. |
| A2 + P4 + P1 one reaction, derived nesting, one-row moves | POD-4757 | **Fully** (letter), partly (intent) | letter yes, intent partly | One filing reaction per issue in memory (`worklist/visible.ts:1081-1092`). The visible order and group lanes are maintained by binary-search moves (`worklist/sorted-lanes.ts:73-100`). Formal children come from the engine bucket (`pool.ts:430`); nest children are derived (`models.ts:441-447`); `groups.keys` sorts group heads only (`worklist/groups.ts:357-365`). **Gaps:** each move copies the whole group lane (`groups.ts:251-258`); the seat mirror is still a hand-kept index (`pool.ts:286-336`); and the filing reaction is held by every resident issue, hidden ones included. |
| A5 schema navigation | POD-4758 | **Partly** | letter partly, intent partly | `relations.ts` names no entity or relation. The issueless subset is declared (`shared/src/schema.ts:931`). Typed getters are installed (`models.ts:265-305`) with a compile-time negative control (`navigation.test.ts:82`). **But no derivation uses the getters**: parts read id-links so the rebuild can run them over plain maps (`models.ts:32-34`). Three untyped strings remain: `pool.ts:318` (`'issue.sessions'`), `tables.ts:204`, `models.ts:679`. |
| M2 plant and measurement doors out | POD-4759 | **Partly** | letter yes, intent partly | Counters, the fence and the `seats()` doors are gone. Test-only code remains under other names (§3.7). |
| (test helpers out of product) | POD-4760 | **Not** in intent | letter yes, intent no | The harness helpers moved to the adapter, and strict flags are set only by `mobx-trap.ts:31`. **But the adapter re-implements `create()`** (`harness/src/adapters/mobx-pool.ts:165-244` against `arm.ts:49-114`). Every test, the census, the gates, the web entries and the live page (`apps/web/harness/proto-live-entry.tsx:42,117`) run the copy. **`mobxPoolArm` is run only by `cold-rule.test.ts`, and `writableMobxPoolArm` by nothing.** PL1 (the product write arm ignores receipts) leaves every test green. |
| (list flatten) | POD-4792 | **Partly** | letter yes, intent partly | In the `all` layout each lane is its own observer (`react/list.tsx:147-167`). In the browser's window layout, any lane change re-renders `PoolList`, builds a new plan, and the virtualizer re-measures every index (the file's own header, `react/list.tsx:35-38`). The count lane (happy-dom) never takes the window layout (`react/list.tsx:283-285`): PL2 is green. The native list passes whole lane arrays to `SectionList` (`native/list.tsx:103-117`, read). |
| (instrument gaps) | POD-4825 | **Fully** (in code) | letter yes, intent partly | The write variants run in work-per-change and the census (base run: green). The growth test's paired t bound exists, but no real matrix run with it is in the repo. |
| M1 one copy of each rule | in POD-4755 | **Fully** for the three named rules | letter yes, intent partly | `views.ts:216, :251, :263`. The "finished" rule has 4 copies: `worklist/visible.ts:233` and `rollup.ts:360, :591` use `closedReason != null`, but `rollup.ts:450` uses `Boolean(closedReason)`, which differs for `''` (read). |
| M3 history out of comments | — | **Not** | — | Comments are 28.2% of non-test lines (26.9% before), with 143 `POD-` references (168 before). The README still describes `IssueNode`, four reactions per node and the replaced input functions. |
| I5 spy correction | — | **Fully** | — | Done in the earlier review. |

**Met in letter, not in intent:** POD-4760 (the product entry points are untested copies), POD-4759
(test-only code renamed, not removed), POD-4753 (`peek` is still a synchronous read), POD-4746 (a
bound that grows with the group), POD-4792 (the browser and native paths are unmeasured), and H1
(the inventory is still incomplete).

## 2. Linear, compared again

| Aspect | Linear (transcript) | Ours now | Verdict | vs the earlier review |
|---|---|---|---|---|
| **Pool** | "one big pool" of all model objects (t2:207) | One `ObservableMap` per entity, holding the kernel's row object by reference (`tables.ts`) | **Good**: one observable per row, no copy | Same |
| **Change granularity** | Per property; a view re-renders when "individual properties on that model object" change (t2:245-262) | Per row slot at the source. Per field downstream: every row field is its own cached value (`models.ts:494-521`), and the row observer reads fields (`react/row.tsx`) | **At parity** for the view: a row redraws only when a field it shows changes (the displayed-fields fence passes, `POD-4934.md` §4) | Better (was "acceptable, pushes toward many computeds") |
| **Relations** | Decorators (`@ManyToOne`, `@OneToMany`) maintain the inverse (t1:878-949) | Declared in `shared/src/schema.ts` and maintained by one engine that names no relation (`relations.ts`) | **Better than Linear.** One exception: the seat mirror (`pool.ts:318`) | Better (the `issueless` hard-coding is gone) |
| **Navigation** | `issue.team.name`, typed | `issue.parent`, `issue.children` and so on, installed from the schema and typed (`models.ts:265-305`); `LOADING` is in the type only for lazy relations | **At parity for consumers.** Derivations still use typed id-links (`links.issue.children.ids`), because the rebuild must run the same parts over plain maps | Better (was "worse") |
| **Collections** | Own `Collection`; `LazyCollection` (t2:1075-1164) | `LazyCollection` from the getters; `lazyMany` (`pool.ts:659-669`) | Equivalent | Same |
| **When observability is built** | "only when we access those model objects… find them by ID… access a collection" (t2:1240-1250) | Models are built on first request. Cached values are built on first **reactive** read and dropped when unobserved (`cached.ts`), so 0 at construction and 19.6 per visible row at first paint. **But every issue in memory takes a filing reaction at bootstrap** (2,736 at 1x; 5,895 at history ×10), and its first run evaluates that issue's visibility: 13,343 computed runs and 120,678 row reads at 1x (`tracking-counts.baseline.json`, `1x.phases.firstReactiveRun`) | **Close to Linear for objects. Not for bootstrap**: all resident issues are evaluated once | Much better (was "the key divergence") |
| **Derived state** | Views observe the graph; there are no per-model reactions | One reaction per resident issue files it into maintained sorted lanes (visible order, pinned, group members, open, closed) | **A deliberate divergence, justified by measurement** (review §4.8: a view-time filter costs 9–10 ms per change at 4x). Its cost is one listener per resident entity, including rows that can never show | Better (four reactions became one) |
| **Lists** | Sorted and grouped at render time, virtualised | Lanes maintained one move at a time (no re-sort); each move copies its group lane; the web list is windowed, but the virtualizer re-measures every index per lane change | **Good shape**, with O(group) per move and O(visible) in the browser window | Better (no re-sorts) |
| **Optimistic write** | Mutate the model; `save()` records old values; roll back on rejection (t1:1014-1018) | `issue.title = x` is one transaction (`models.ts:528`). The overlay sits inside the one reader. Rewind goes to the latest server value. The TTL timer is wired | **Linear's shape, better semantics** | Better (the placement is fixed) |
| **Lazy load mechanics** | Local disk, then the network; batched; Suspense (t2) | A 50 ms batched window with `LOADING`, **over the kernel's in-memory replica**, plus **33 synchronous `peek` reads** of cold rows per first window (probe 4) | The mechanism is right for a tier that does not exist yet | Same; `peek` is new evidence |
| **Partial bootstrap** | Load only what the app needs now; the rest waits (t2:1024-1040) | Not built: the kernel holds everything, and the pool indexes every known row | **Missing** (the cutoff is deferred) | Same |
| **Type-level laziness** | `CachedPromise`, `Hydrated<T>` | `Loaded<T>` / `LOADING`; Rule L computed from the schema and reflected in the getter types (`IsLazy`, `models.ts:380-384`) | **Good, more formal** | Better |

**Summary.** The objects and the write path are now Linear's design, and in two places better
(validated schema relations, rewind to server truth). The two real differences are:
- **Incremental list bookkeeping** with a listener per resident issue. This was chosen on evidence,
  and is right for the scale target if it is limited to rows that can show.
- **No partial bootstrap.** That is the deferred cutoff.

## 3. The round-three traps

### 3.1 Relations maintained by hand: **found, one**
The seat mirror (`pool.ts:286-336`) is a sorted copy of the engine's `issue.sessions` bucket. It is
kept by an `onBucket` hook that tests the literal string `'issue.sessions'` (`pool.ts:318`). It
exists because the old read fence charged for bucket IDs, which the scale-invariant work check
(POD-4746) no longer does. Everything else is schema-driven: `relations.ts` names no relation.

### 3.2 A derivation reading the whole corpus: **none per change; one at bootstrap**
- No derivation walks every issue on a change. Probe 3 shows the same rename costs 1 computed run
  at history ×1 and ×10, and a heartbeat on a hidden session costs 0.
- At bootstrap, every **resident** issue's filing reaction evaluates its visibility, and that set
  grows with history (§4e).
- `issueIds` (`pool.ts:561-564`) is a whole-table computed with no product reader. Its only chain
  is the adapter's `residentIssueIdsOf`, which feeds an ignored parameter (`rebuild.ts:83`, read).

### 3.3 A listener per entity: **found, by design, too wide**
One filing reaction per issue in memory (`worklist/visible.ts:1081-1092`, `pool.ts:510`). The
earlier review's §4.8 justified incremental filing for rows that can show. Today, though, the
reaction is held by every resident issue:

| Resident issues | 1x | history ×10 |
|---|---|---|
| Archived but not closed | 147 | 1,470 |
| Deleted | 54 | 540 |
| Closed that the rule keeps but that never show | 194 | 1,544 |

At 1x, 570 closed issues are resident against 376 closed visible rows; at history ×10, 1,920
against the same 376 (probe 1). None of these can appear in the list, yet each holds a reaction and
evaluates its visibility at bootstrap.

### 3.4 Whole arrays as props: **web no, native yes**
- **Web:** lanes take a lane name and key, slots take `pool` and `id` (`react/list.tsx`).
- **Native:** `SectionList` receives `sections` holding whole lane arrays, rebuilt on every lane
  change (`native/list.tsx:103-117`, read).

### 3.5 An arm's own copy of a shared rule: **found, three**
- `LEGACY_CLOSE_REASONS` exists once per arm (`views.ts:216`, and the hand arm's own).
- The hidden-issue summary `HIDDEN_ISSUE_FIELDS` is declared in the arm (`worklist/visible.ts:219`),
  not in the shared schema (cutoff rule 3).
- The "finished" predicate has 4 copies, one of which disagrees on `''` (§1, M1).

### 3.6 An allowance widened to cover a harness flaw: **none for MobX, one structural looseness**
- The roster gives MobX no allowance (`roster.ts:110-119`).
- The work check's bound is the changed items' neighbourhood at 4x, which includes whole groups. So
  O(group) work passes by construction. POD-4757 proved a whole-group re-sort passes it, and PL3
  repeats that.
- Separately, POD-4759 deleted checks with no outside replacement: coexist's "co-mounted work equals
  solo" (`710b88a6c`, verified in the diff), and residency's `notifications=1` / `tableWrites=0`
  (read). Together these are an instrument weaker than before.

### 3.7 Test-only code in product code: **found, loudly**
Non-test files under `arms/mobx/pool/`:

- **The test knob `outOfMemory` and its `heldOut` machinery.** "Tests use it" (`pool.ts:148-153`,
  `:230-237`, `:739-757`; `residency.ts` about 10 sites). It adds a second tracking path into the
  product's filing logic.
- **Arm-contract dummies.** A zero `stats` object (`arm.ts:66-72`), an unused `_reads` parameter
  (`arm.ts:53`), and `pool` exposed on the handle "(tests …)".
- **Members only tests or the adapter read:**
  - `modelCount` (`pool.ts:693-696`)
  - `VisibleCollection.order` (a copy of the maintained list, "only the snapshot and tests",
    `worklist/visible.ts:1070-1073`), `trackedIds` and `size` (`:1114-1122`)
  - `Residency.size`, `summaryCount`, `registeredTarget`, `queued`, `hasQueued`
  - `PoolRelations.summaryCount`
  - `DeadlineClock.waiting`
  - `MobxWriteApi.log`
  - `issueIds` (above)
- **Dead counters.** `IngestOut.writes`, `.cold` and `.volatile` are incremented but never read
  (`tables.ts:97-108`, read).
- **Gate and oracle code** in product modules:
  - `enumerate.ts`: `knownTables`, `scanRelations`, `diffRelations`, `diffResidency`
  - all of `rebuild.ts`
  - `enforce.ts` and `mobx-trap.ts` (which imports vitest)
  - `tracking-counts.baseline.json`
- **The inverse problem.** The product entry points are not what the tests run (§1, POD-4760).

## 4. The operator's promises

### 4a. Does nothing when nothing happens
- **Proven:** after create, a 20-row paint and the load window settling (2 rounds), **0 timers are
  armed**. A 1 ms clock advance runs **0 computeds and 0 reactions**. The control (a 24 h advance)
  runs 68 computeds and 8 reactions, so the census is live (probe 2). The load window arms only
  while loads are queued (`residency.ts:156`). The TTL timer arms only while receipted edits exist
  (`write/edit.ts:218-231`).
- **Not proven:** the browser. No count lane runs the windowed list, and nothing measures idle
  frames or scroll handlers.
- **Known:** the live page's own twice-a-second snapshot (POD-4537) is harness work, not pool work.

### 4b. An incoming update costs only what it changes
- **Proven:** the base run's work check.
  - 16 scenarios, each at 1x and 4x, for the bare pool and for the write layer idle and pending.
  - Rows and derivations are flat except #8b, where more rows really cross the clock.
  - The same rename at history ×1 and ×10 re-runs 1 computed; a hidden session's heartbeat runs 0
    (probe 3).
- **Not proven, and not true in the strict sense:** a row entering, leaving or moving copies its
  group lane (`GroupNode.baseRowIds`, `groups.ts:251-258`) and the lane observer re-maps it.
  - #6a (new issue) walks 498 elements at 1x and 1,719 at 4x.
  - #6b (archive) walks 274 → 1,719; #8b (grace crossing) 582 → 3,069.
  - The check passes because the bound is the group. In the browser window, `PoolList` also
    rebuilds its plan and the virtualizer re-measures every index (PL2: uncounted).
- **Untested:** the native list per change.

### 4c. A local interaction is fast
- **Counts:**
  - A selection click is 2 derivations, 81 elements, flat 1x→4x.
  - An optimistic press, echo or rejection is 0 derivations and about 44 elements.
  - A rename is 10 derivations.
- **Walls:** the last browser matrix (`POD-4747.md`, `d9a6be7c2`, before the rework) put the click
  at 13.5 ms raw at h1a1, mostly engine floor.
  - Nothing since then measures input → paint in a browser with the reworked pool.
  - The four full-size gates now running are correctness gates, not timing.
- **Untested:** a real React Native renderer (G7 is still not met); the browser window path per
  change.

### 4d. It is hard to get wrong
**What holds:**
- Automatic dependency tracking.
- The four strict MobX flags plus a trap that turns every warning into a test failure (`enforce.ts`,
  `mobx-trap.ts`).
- Lint: `mobx/missing-observer` and `exhaustive-make-observable`; `views.ts` may not import
  `relations.ts`.
- One reader: PL4, a part that reads the table directly, turns `write/reader.test.tsx` red.
- The gate compares every step with a from-scratch rebuild.

**What can still go wrong silently:**
1. **A new `peek` caller.** It is a synchronous read of a cold row. Nothing forbids a new one: no
   lint or test counts peek sites (cutoff rule 1). Probe 4 finds 33 such reads per first window.
2. **An untracked plain read inside a derivation.** The inventory is still incomplete (§1, H1), and
   nothing but review enforces it.
3. **The private MobX API.** `cached.ts` uses `_getGlobalState` and `_isComputingDerivation`, with
   MobX pinned at 7.0.3. In production (strict flags off), a group read outside a reaction is
   recomputed afresh every time, without a warning.
4. **A bypass of the one reader.** PL4 is caught only because the test holds a pending edit on that
   field. Lint does not see `issue.host.tables` in a part.
5. **The product entry point and write wiring.** They are untested; PL1 is green.
6. **The row's capability limit** is type-only (`row.host` is the pool at runtime).

**Strict mode in production:** off by design (POD-4760). That is right for speed, but it means
every item above is silent in the app.

### 4e. It keeps working as data grows
**Per change: yes, on both axes** (4b; probe 3). **Startup and memory: no.**

Probe 1, pool created and a 20-row window painted, counted from outside:

| | h1a1 | h10a1 (history ×10) | ×, history | h1a4 (active ×4) | ×, active |
|---|---|---|---|---|---|
| Known issues / sessions | 4,867 / 4,304 | 27,601 / 30,611 | 5.7 / 7.1 | 11,890 / 8,447 | 2.4 / 2.0 |
| Visible rows | 732 | 732 | 1.0 | 2,928 | 4.0 |
| Resident issues (= filing reactions) | 2,736 | 5,895 | **2.2** | 9,759 | 3.6 |
| Resident sessions | 2,548 | 12,742 | **5.0** | 6,691 | 2.6 |
| Issue objects built | 3,252 | 8,456 | 2.6 | 10,207 | 3.1 |
| `readStates` entries (every known issue) | 4,867 | 27,601 | 5.7 | 11,890 | 2.4 |
| Computeds (after paint) | 14,360 | 30,488 | 2.1 | 47,046 | 3.3 |
| Observable values | 39,135 | 122,165 | 3.1 | 124,521 | 3.2 |
| Map entries / set members held | 28,577 / 14,642 | 99,154 / 59,682 | 3.5 / 4.1 | 90,672 / 45,066 | 3.2 / 3.1 |
| Array elements held | 5,823 | 26,352 | 4.5 | 16,455 | 2.8 |

Why the pool grows with history (probe 1, resident rows checked against the shared rule itself;
pool and rule disagree on 0 rows):
- **The cold predicate is `closedAt != null` only** (`shared/src/schema.ts:755`). So:
  - archived issues that were never closed stay resident: 1,470 at h10a1;
  - so do deleted ones: 540;
  - so do their sessions;
  - and so does every unbound session, which inherits from no issue: 6,432 of 6,432.
- **The rule's upper bound is loose.** It keeps 1,920 closed issues at h10a1 against 376 closed
  visible rows. My direct attempt to name the keeper (open human stage, root with a reason, a member
  run that never stopped) explains 82 of them. The rest need the rule's own attribution: the first
  step of MUST-FIX 4.
- **Indexes are keyed by known rows** (cutoff rule 2, violated since before the rules): `readStates`,
  the relation engine's cold twins and summaries, the collapse and prefix indexes,
  `Residency.cold`/`finish`/`dependents`/`keeps`, and the seat mirror (read; listed in the helper's
  report).

**Heap:** not re-measured on the history axis since the rework. Before it, the browser heap went
40 → 161 MB and cold start 652 → 2,405 ms (`POD-4747.md`). After it, the JSC heap goes 63.9 MB at
1x → 256.5 MB at 4x on the both-axes corpus (`POD-4934.md`).

**The four cutoff rules today:**

| Rule | Status | Evidence |
|---|---|---|
| (1) Every read through `row()`, no new peek callers | **Partly** | No new peek callers. The engine, ingest and residency read raw tables, by design. |
| (2) Indexes cover resident rows only | **Not met** | The list above. |
| (3) A small declared summary | **Met** | 4 fields, but declared in the arm, not the schema. |
| (4) Absent answers LOADING, batched, never blocks | **Partly** | Load and mark reads comply; `peek` blocks on the feed (probe 4: 33 reads). |

## 5. Ready for the pilot?

**Yes, this is the design to pilot, after the four must-fixes (§7) and POD-4940.** What it takes to
move the pool into a real package, fed by the real replica, behind a switch (plan phases D–F):

**Seams to the real client engine** (`packages/client-core`):
1. **The per-row feed.** `shared/src/row-source.ts` already sits over client-core. It reads
   `replica.row(kind, id)` and folds `runtime.pendingOverlaysByRow` per row. It imports
   `@podium/client-core/replica` and `/store` (`row-source.ts:132-141`).
   - It must become a supported client-core port, which is plan D3 ("addressed replica changes
     through the binding").
   - It must keep its `truth` mode, because the pool owns optimism.
   - `RowSource.row` stays synchronous for the pilot, since the kernel holds everything. The cutoff
     will make it asynchronous, which the pool is already shaped for (`LOADING` plus the batched
     window).
2. **The receipts.** `shared/src/receipts.ts` (L3b) and `WriteTransport`
   (`shared/src/write-contract.ts:234-260`) must become client-core outbox events. This is plan D4
   ("effective changes from the optimistic path"). The kernel keeps the command, queue, persistence,
   echo and collapse; the pool's `write/` keeps the display.
3. **The locals** (selection, coarse clock). `harness/src/engine-locals.ts` must become a
   runtime-owned source.
4. **The schema.** `shared/src/schema.ts` must move with the pool, not stay in a prototype package.
   Its field names are the kernel's wire names.
5. **The switch.** The plan's `presentationModel` flag and the D6 differential gate do not exist on
   this branch; grep finds neither. The L4b gate (a random change against a from-scratch rebuild)
   is the natural D6. It must be ported to run against client-core's runtime, not the scenario
   engine.

**What moves:**
- `tables`, `relations`, `residency`, `models`, `cached`, `clock`, `views`
- `worklist/{visible,groups,sorted-lanes,rollup}`
- `write/{edit,overlay,pending}`
- `react/*` and `native/*`
- **one** entry point (MUST-FIX 1)

**What must not move:**
- `rebuild.ts`
- `enumerate.ts`'s gate functions (`knownTables`, `scanRelations`, `diffRelations`, `diffResidency`)
- `enforce.ts` and `mobx-trap.ts`
- the `outOfMemory`/`heldOut` knob
- the `stats` dummy and `_reads`
- the test accessors (§3.7)
- `tracking-counts.baseline.json`
- the harness adapter

**New dependencies for `apps/web` and `apps/mobile`:** `mobx` 7.0.3 and `mobx-react-lite` 5.0.3,
plus `@tanstack/react-virtual`. `cached.ts` depends on MobX's private exports, so the pin must be
exact.

## 6. Open risks, ranked

1. **Startup and memory grow with history** (§4e). The operator's history grows forever, and the
   cutoff is deferred. The pilot's bootstrap on real data will carry every archived, deleted and
   unbound-session row, with a reaction per resident issue.
   - Known bad before the rework: 161 MB at history ×10.
   - Not re-measured after it. The count proxy says the pool's reactive structures still grow 2–5×.
2. **The paths the pilot runs are not the paths the instruments run.**
   - The product entry point and write wiring (PL1).
   - The browser's windowed list, with O(visible) virtualizer work per lane change (PL2).
   - The native `SectionList` with whole arrays.
   - The live demo, which mounts the harness copy.
3. **Parity on live data.** POD-4940 is open. The fixture-based gates (20 × 300) did not see a gap
   that one look at real data did, so the oracle's blind spots are real.
4. **Private MobX API** (`cached.ts`), and a census that traps MobX internals. A MobX upgrade can
   break the pool or silently blind the instrument.
5. **The work check's bound grows with the group** (PL3). A per-change regression of order "the
   group" is invisible to it; only targeted tests (`scaling.test.ts`) catch some of them.
6. **`peek`.** It is a synchronous read path that the cutoff must remove, and every new caller makes
   that harder.
7. **The docs describe the old design** (README, 28% comments). A newcomer will learn the
   pre-rework shape.

## 7. MUST-FIX and SHOULD-FIX

### MUST-FIX (before the pilot switch is built)

| # | Fix | Why it blocks the pilot | Sub-issue |
|---|---|---|---|
| 1 | **One product entry point, run by everything.** `mobxPoolArm` / `writableMobxPoolArm` become what every test, census, gate, web entry and the live page create. The harness adapter wraps the product handle and adds only snapshot, rebuild and settle. | The pilot would ship an entry point and write wiring that no test runs (PL1 green). | POD-4944 |
| 2 | **Prototype-only code out of the product modules** (§3.7). Delete, or move to `harness/`. | "Must not move" code would ride into the real package, and the `outOfMemory` knob is a second tracking path in product logic. | POD-4945 |
| 3 | **Count the browser's windowed list and the native list per change, and fix what they find.** | The pilot's hot path is the windowed list; today no count sees it (PL2 green), and its header admits O(visible) per lane change. | POD-4946 |
| 4 | **Complete the working-set rule for history.** Archived and deleted issues, and stopped unbound sessions, stay out of memory unless shown; find and close the rule's slack on closed issues; limit filing reactions to rows that can show. | The pool's reactive structures grow 2–5× with history at constant active work (probe 1). The pilot would carry that on real data. The fix is in the shared schema and independent of the deferred cutoff. | POD-4947 |
| — | **POD-4940** (known, in progress): the live-data parity gap. | Correctness on real data. | exists |

### SHOULD-FIX (before the cutoff, or when the file is next touched)

1. **`peek` becomes LOADING.** Cold seats' retention and activity read the declared summary
   (cutoff rule 4); add a check that counts peek sites.
2. **Indexes cover resident rows only.** `readStates`, cold twins, summaries, the seat mirror, the
   collapse and prefix indexes (cutoff rule 2; part of the cutoff).
3. **Tighten the work check's bound** to the moved row's old and new position, not its whole
   group. Restore coexist's co == solo work via the work meter, and residency's one-notification
   check from outside.
4. **Complete the untracked-read inventory** (`relations.ts:446-454` `extraCounts`, `pool.ts:648`),
   and make it a test, not a comment.
5. **The seat mirror**: read the engine's bucket or declare the order in the schema (A5 residue).
6. **One "finished" rule** in `shared/`. Probe `closedReason: ''` against the legacy.
7. **Pin MobX exactly**, and test the private exports `cached.ts` uses.
8. **Test the TTL timer's default `setTimeout` path**; overlay the hidden summary's `stage`.
9. **Rewrite the README and NOTES** for the current design, and move history out of comments (M3).
10. **Relation getters**: either derivations use them, or say plainly they are the consumer API only.

## Appendix: runs

All on flatblock, `~/podium-test-4942`, Bun from `.toolchain`, node lane (`bun run test:file`).
The load average was between 5.9 and 18.8. Counts only.

**Base, at `2d19cd60d` plus the probe file.** All passed:

| File | Result |
|---|---|
| `write/settle.test.tsx` | 9 passed |
| `tracking-counts.test.ts` | 6 passed, 1 skipped (the update mode) |
| `worklist/scaling.test.ts` | 6 passed |
| `write/reader.test.tsx` | 2 passed |
| `worklist/group-label.test.ts` | 1 passed |
| `harness/src/cold-rule.test.ts` | 2 passed |
| `harness/src/work-per-change.test.tsx` | 7 passed (MobX bare, idle, pending all green; hand measured-only; legacy control fails as required) |

MobX work table, 1x → 4x, bare pool (the write variants are the same within a few elements):

| # | Scenario | Rows | Derivations | Elements | Neighbourhood |
|---|---|---|---|---|---|
| #1 | heartbeat | 1→1 | 0→0 | 23→23 | 3→2 |
| #2 | phase | 1→1 | 16→16 | 200→204 | 42→37 |
| #3 | click | 1→1 | 2→2 | 81→81 | 42→37 |
| #4 | rename | 2→2 | 10→10 | 281→285 | 42→37 |
| #5 | stage move | 2→2 | 36→37 | 298→129 | 197→24 |
| #6a | new | 3→3 | 41→41 | 498→1,719 | 410→1,631 |
| #6b | archive | 2→2 | 24→24 | 274→1,719 | 185→1,630 |
| #6c | evict | 1→1 | 15→10 | 228→1,662 | 184→1,632 |
| #6d | evict keeper | 1→1 | 28→28 | 466→726 | 411→671 |
| #7 | reparent | 2→2 | 45→45 | 314→365 | 59→56 |
| #8 | tick | 0→0 | 0→0 | 1→1 | 0→0 |
| #8b | grace | 6→24 | 113→397 | 582→3,069 | 470→2,843 |
| #9a | press | 1→1 | 0→0 | 44→43 | 8→5 |
| #9b | echo | 1→1 | 0→0 | 44→43 | 8→5 |
| #9c | reject | 1→1 | 0→0 | 46→45 | 8→5 |
| #10 | burst | 98→98 | 914→901 | 2,120→1,876 | 354→302 |

**Probes** (`harness/review/post-rework-probes.test.ts`, 4 passed). The raw JSON lines are printed
as `[probe] …`:
1. **Growth.** The §4e table. Resident rows by kind:
   - h1a1: open 1,965, archived-open 147, closed 570, deleted 54; unbound sessions 654/654 resident.
   - h10a1: open 1,965, archived-open 1,470, closed 1,920, deleted 540; unbound sessions
     6,432/6,432 resident.
   - Resident closed or session rows that the shared rule calls cold: 0 at every cell.
2. **Idle.** Load rounds 2; armed timers after settle 0; 1 ms tick: no work recorded; control 24 h
   tick: 68 computed runs, 8 reaction runs, 25 changes.
3. **History step** (targets `s2623` / `i214` at both cells). Heartbeat: no work. Rename:
   1 computed run, 0 reactions, 1 change, at h1a1 and at h10a1.
4. **Peek.** At h1a1 and at h10a1 alike: 0 after create, 0 after paint, 33 after the window settles
   (74 feed row reads in all).

**Plants** (each backed up with `cp`, edited, run, restored with `cp`; the checkout was clean
afterwards):

| Plant | Edit | Ran | Result | Meaning |
|---|---|---|---|---|
| PL1 | `write/arm.ts:52`: the product write arm ignores `accepted` receipts | `write/settle`, `write/edit`, `write/reader`, `cold-rule` | **4 files, 23 tests green** | No test runs the product write arm: a pilot could ship broken receipt handling (MUST-FIX 1) |
| PL4 | `models.ts:472`: `loaded` reads `host.tables.issue.get` instead of the one reader | `write/reader`, `write/edit`, MobX lint on `models.ts` | **6 tests red** (`reader`: "model, row view, reader and visibility agree"; `edit`: rename paints, setters); MobX lint **exit 0** | The one-reader rule is held by tests, not by lint |
| PL2 | `react/list.tsx:242`: `WindowPlan` reads every visible row's rank per build | `work-per-change` | **7 tests green** (all MobX variants) | The browser window path is never counted (MUST-FIX 3) |
| PL3 | `worklist/groups.ts:342`: every filing copies and sorts its whole group lane | `work-per-change`, `worklist/scaling` | `work-per-change` **green**; `scaling` **red** ("sorted elements … expected 464 to be less than 24" at 1x, 1,817 at 4x) | The general work check allows whole-group work; only the targeted scaling test catches it |
