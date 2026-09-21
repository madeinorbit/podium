# POD-4449 — H4 shape review of all three round-two arms

Reviewer: this issue's session. **I did not build any of the three arms** — no
commit on `integrate/4441-round-two` in `packages/worklist-proto/arms/*` is
mine; my only change in this review is this document. Read order per arm:
README, then code top to bottom, then tests. Load was above 8 for the whole
review (`uptime` 9.29 at start, 7.73 at test time), so per the hygiene rule all
evidence below is counts, code reads and executed assertions — no wall timing.

**One-line verdict: all three arms PASS.** No arm is sent back; no I-phase
issue stays blocked on shape. What follows is the evidence that convinced me,
not an absence of findings — the review names real problems (a typecheck gap
that weakens the hand arm's core claim, uncounted O(visible) scans in all
three arms, a classification asymmetry behind TanStack's 7-vs-3), and judges
each one as PASS-with-follow-up or residual risk rather than FAIL, with the
reasoning written down so I-phase can check it.

## 1. Checklist tables (methodology §6.1)

### 1a. Hand-rolled arm (POD-4446)

| Check (6.1) | Verdict | Evidence |
|---|---|---|
| No import from `viewmodels/`, `slices/`, `mission.ts`, `presentation/`, `replica/issue-view*` | PASS | Zero import statements match; the only hits are spec citations in comments (`rules.ts:8`, `rollup.ts:122,159,167,182,198`, `indexes.ts:19,113`, `deltas.ts:25`). `arm.ts` imports only `shared/`, `./store`, react. |
| Entities keyed by id, values immutable borrowed rows | PASS | `tables.ts:14-72`: three `Map<string, …>` tables, stored by reference (`previous === record.value` no-op at :25,45,64), never spread; evict is `rows.delete` (:20,41,61). |
| No derivation enumerates a table on an ordinary delta (delta handlers only) | PASS | All `apply(batch)` walk dirty ids, index buckets or ancestor chains: `summary.ts:113-151`, `visible.ts:318-407` (subtree/bucket walks), `rollup.ts:386-449` (seeds + chains), `order.ts:78-136`, `groups.ts:78-143`, `rows.ts:75-118`. Full scans exist only in `rebuildAll` (bootstrap/replace/test oracle) and `groups.rebuild` over the *order array* — see residual R-H1. |
| Dependency correctness by construction: every handler an exhaustive switch over the delta union; rebuild oracle test present | PASS | `assertNever` terminates 9 switches: `deltas.ts:48` (def) + `indexes.ts:542`, `summary.ts:146`, `visible.ts:352`, `rollup.ts:430`, `order.ts:116`, `groups.ts:113`, `rows.ts:113`, `store.ts:242`. `rebuildFromScratch` (`rebuild.ts`) is invoked per scenario in `hand.test.ts:102-123`, `hand.engine.test.tsx:36`, `hand.1x.test.tsx:45`, `hand.fixture.test.ts`, `hand.ui.test.tsx:65`. |
| Row isolation: one subscription key per row | PASS | `react/list.tsx:38-61`: row reads its own key + `selected:<id>` via `useSyncExternalStore`, `memo` on stable `{store, id}` props; headers `group:<key>`; list `order` only (:96). Tick is read direct from `store.rollup.ticks` (:48) but always rides the commit (`rows.ts:63-70` compares `[next, tick]`), so no stale read. |
| Lifecycle explicit: release on evict; replace clears tables | PASS | Evict deletes row + buckets (`tables.ts` + `indexes` removal arms); `store.ts:147-173` clears, reseeds, rebuilds, one notification (`dispatch` :176-179 counts one). `dispose()` unsubscribes source, unmounts, clears listeners (:357-363); `hand.test.ts:436-447` asserts dispose leaves zero listeners. |
| Own UI, windowed, no whole-array props | PASS | `react/list.tsx` (fixed heights + overscan, full-render fallback at height 0), `native.tsx` (ScrollView-full for M1, same as control lane). `grep issues=/sessions=` over `react/` + `native.tsx`: empty. |

**Verdict: PASS.** Required follow-up (not a send-back): F-H1 below.

### 1b. MobX arm (POD-4447)

| Check (6.1) | Verdict | Evidence |
|---|---|---|
| No import from legacy view-model / slice / mission / presentation / replica-view | PASS | Zero import statements match; hits are comments only (`models/issue.ts:218`, `rules.ts:6,387`, `store.ts:689`). `arm.ts` imports `./config`, `shared/`, `./store`, react. |
| Entities keyed by id, values immutable borrowed rows | PASS | `store.ts:64-66`: shallow `observable.map`s of models; row behind `observable.ref` (`models/issue.ts:92`), replaced never mutated (`store.ts:267,279,291`); same-reference no-op (:266,278,290); evict is `map.delete` (:263,275,287). |
| No computed reads `map.values()` outside `WorklistModel.visibleIds` | PASS | The `.keys()`/`.values()` hits are write-path actions or plain helpers, never computeds: `store.ts:234-236` (replace), `:308-310` (bootstrap), `:549` (`roots()`, called from `resolveCwd` ← actions `ingestSession`/`resolveAllUnbound`), `:674` (local branch map in `spinOffTip`). `visibleIds` (`worklist.ts:37-43`) is the one enumeration, with `shallowIdsEqual` keeping identity. |
| Enforcement config on; no `keepAlive`; `eslint-plugin-mobx` clean | PASS | `config.ts:20-25` sets all four flags, imported by `arm.ts:9`, which every test file imports (`mobx.test.ts:16`, `mobx.1x/engine/fixture/ui` likewise). `keepAlive` appears only in comments. `bunx eslint --config arms/mobx/eslint.config.mjs arms/mobx` run by reviewer: **zero output, clean.** `makeObservable` annotations verified exhaustive by reading against the class member list (`models/issue.ts:81-116`; `store.ts:145-204`). |
| Row isolation: `observer` per row | PASS | `react/list.tsx:25-58`: `observer` row reads `model.row` + `model.isSelected` + `model.tick`; model object passed as prop (stable identity). List reads `worklist.groups` (:89-90), not `order` — equivalent granularity (any order change flows into `groups`, which carries `computedStruct` equality). Headers read their group slice (:67). No whole-array props (grep empty). |
| Lifecycle explicit: store per principal; `map.delete` on evict | PASS | One `MobXStore` per `arm.create`; `apply` is an `action` (`store.ts:170`) so replace (:217-241: clear + reseed + `resolveAllUnbound`, one notification) is atomic. `dispose()` detaches source, unmounts, clears all 15 maps (:791-812); `mobx.test.ts:375-390` asserts removal disposes buckets, dispose clears tables, post-dispose pushes inert. |
| Own UI, windowed, no whole-array props | PASS | `react/list.tsx` (same windowing contract as hand), `native/list.tsx` (ScrollView-full M1). |

**Verdict: PASS.** No follow-up owned by the arm; adjudications in §4.

### 1c. TanStack DB arm (POD-4448)

| Check (6.1) | Verdict | Evidence |
|---|---|---|
| No import from legacy view-model / slice / mission / presentation / replica-view | PASS | Zero import statements match; one comment citation (`rules.ts:6,353`). Imports are `@tanstack/db`, `shared/`, sibling arm files, react. |
| Entities keyed by id, values immutable borrowed rows | PASS | `EntitySync` per entity (`collections.ts:30-143`), `getKey` by id; upsert stores the borrowed object (`write` :84-112, same-reference skip :100); remove deletes by key. Only `fn` outputs are fresh objects (derived values by construction — declared, `README.md:17`). |
| No full-collection query without an index | PASS | Entity indexes: parentId, origin edge, repoId, `sessions.issueId`, worktree path (`collections.ts:332-336`). Derived indexes: `aggQ.owner`, `aggR.owner`, `summaryQ.id`, `issuesN.worktreePath` (`queries.ts:677-682`). Remaining joins are on primary `getKey`s (`verdictQ` on `issues.id`, `rowsQ` on `s.id = r.id`) or the 1-row locals marker. 14/14 `createLiveQueryCollection` calls carry `gcTime: GC_TIME_MS` (lines 401,440,478,496,537,556,573,590,605,663,711,727,767,784). |
| Derived collections chained from live queries; only the recursive closure is imperative | PASS | 14 live queries chain entity → narrow → resolve → verdicts → aggs → issuesN/child → summary → visible → order/lane/groups/rows (`queries.ts`). The single `EntitySync<RollupRow>` + `RollupSync` (`rollup.ts:121-169`) owns subtree aggregates, keeper chains, nesting drops, tick, rank/lane denorm — Q2 adjudicated in §4, held to be inside the one allowed sync. |
| Row isolation: per-row keyed subscription | PASS | `react/list.tsx:41-64`: `subscribeChanges` filtered by key + `useSyncExternalStore` per key (row + `selected:<id>`); the `findOne`-per-row variant was measured and rejected (keyed 3.5 ms vs 6.2 ms, 0 vs 1 live query per row — `tanstack.ui.test.tsx`, NOTES). List reads `order` only (:99); tick rides the rowsQ fold + commit compare (`store.ts:351-359`). No whole-array props (grep empty). |
| Lifecycle explicit: `gcTime` set; replace via one transaction | PASS | `GC_TIME_MS` on all 18 collections/queries. Replace (`store.ts:246-276`): per-collection truncate+writes + prefix reseed + `rollup.rebuildAll` + `reconcileAfterReplace`, inside `rollup.batchDuring` with a single `finishCycle` notify — one observable pass. `dispose()` unsubscribes store + rollup subs, clears listeners, cleanups reverse-topology dependents-first (`store.ts:560-602`); `tanstack.test.ts:461-463` asserts zero listeners. |
| Own UI, windowed, no whole-array props | PASS | `react/list.tsx` (hand-rolled windowing, same contract), `native.tsx` (ScrollView-full M1). |

**Verdict: PASS.** Residuals R-T1/R-T2 in §3.

## 2. Mechanical check results (pasted per the brief)

- (a) Forbidden-import grep per arm: hits are comment citations only (listed in §1 tables); a second grep over `^import|require(` against legacy paths: **empty in all three arms.**
- (b) `missionRollup|sourceEqual|allIssueViewModels|buildUnifiedRows|issueModelsBySnapshot|WORKLIST_INPUTS`: two comment hits (`hand/rollup.ts:198`, `hand/rules.ts:393`, `tanstack/rules.ts:374`) — no copied legacy code.
- (c) Hand: 9 `assertNever` sites (§1a); rebuild oracle invoked per scenario in 5 test files. Executed: `hand.test.ts` green (in the 41-test run below).
- (d) MobX: `keepAlive` comments-only; `configure` in `config.ts`, loaded via `arm.ts` in all 5 test files; eslint run clean (reviewer-ran, empty output); `.values()/.size/.keys()` confined per §1b.
- (e) TanStack: 14/14 queries `gcTime`; indexes per §1c; only imperative derivation `rollup.ts`.
- (f) All arms: whole-array-prop grep empty; per-row subscriptions verified by reading all three Row components; lists subscribe to `order` (MobX: `groups`, equivalent — §1b); dispose-zero tested in all three (`hand.test.ts:447`, `mobx.test.ts:383-390`, `tanstack.test.ts:461-463`); replace clears+reseeds in one action/transaction in all three; native entries exist in all three.
- Executed: `bun run test:file -- arms/hand/hand.test.ts arms/mobx/mobx.test.ts arms/tanstack/tanstack.test.ts` → **3 files, 41 tests, all green** (load 7.73, counts only).

## 3. Stats honesty

**PASS for all three arms — no undercount found.** Every derivation-body counter
was traced to its bump site:

- Hand: `summaries()` at `summary.ts:74` (post structural-exclusion gate),
  `aggregates()` at `rollup.ts:268`, `visibility()` at `visible.ts:56`,
  `index()` at 10 bucket-write sites in `indexes.ts`, `rows(n)` on commit
  (`rows.ts:58,68`). `rebuild.ts` constructs modules with default `nullStats`,
  so the oracle never pollutes counters.
- MobX: `flat`/`summary`/`aggregate` bump at body top
  (`models/issue.ts:154,193,224`); `rowsDerived` on commit only
  (`row` :344,355,374; `tick` :290); bucket writes in actions. Counting is
  observation-driven (suspending computeds don't run) — disclosed in README
  and consistent with the mounted-test count assertions.
- TanStack: every `fn` body bumps `GraphRuns` (`queries.ts:410,453,488,502,
  548,598,636,736,794`; pure-DSL queries have no `fn` — disclosed);
  `finishCycle` transfers summary+rows deltas into `rollupsDerived`
  (`store.ts:288`); rollup `compute()` counts post-`final` gate
  (`rollup.ts:421`); seat writes counted with del+ins netting
  (`rollup.ts:819-830`, `flushBatch` :1061-1065).

Two classification notes (adjudicated in §4, not undercounts): hand's
`visibility()` fires pre-gate while its `summaries()` fires post-gate
(`visible.ts:56` vs `summary.ts:74`); TanStack counts rowsQ `fn` runs where
the other arms count row commits. Both disclosed in code; the shared
classification question is answered in §4.

**Residuals — uncounted O(visible) work on hot paths (all three; I-phase
slope material, not H4 FAILs):**

- R-H1 (hand): `groups.ts:121` `ordered.includes(id)` per dirty row,
  `groups.rebuild` full-order scan (:154) on any touched group,
  `order.ts` `indexOf` per move. `GroupsModule` even takes `void stats`
  (:49) — group/order CPU is invisible to every counter.
- R-M1 (mobx): `moveSeat` (`store.ts:437-444`) spreads the whole bucket map
  per issue ingest (O(worktree/repo buckets) per delta); `roots()`
  (:548-550) spreads both key sets per unbound-session resolve.
- R-T1 (tanstack): `rebuildOrder` (`store.ts:390-452`) re-buckets the full
  `orderQ` array plus a whole-order `JSON.stringify` compare on **every**
  cycle including no-op heartbeats — the most eager of the three.
  `ingestIssue`'s removal branch scans all of `dependentsOf`
  (`rollup.ts:934`). `PrefixIndex.moveSeat` full-map scans
  (`collections.ts:199-220`).
- R-H2 (hand): `rebuildRootsAfterIssue` (`indexes.ts:404`) has no callers —
  dead code, remove.
- R-H3 (hand): `store.tableApply`'s `record.kind` switch (`store.ts:114-121`)
  has no `assertNever`; a new stream kind would be runtime-loud (undefined
  pushed into the batch, crash on `.kind`) rather than compile-loud. Same
  shape in MobX `tableApply` (`store.ts:258-295`). One-line hardening for
  I-phase.

## 4. Adjudications

**Q-H1/M1/T1 — line budget vs fidelity.** Adopt measured totals
(`wc -l`, non-test sources): hand **3,589** (code-only ~3,092), MobX
**2,399** (code-only 1,954), TanStack **3,874** (code-only ~3,360). This
resolves the brief's number question: the coordinator's counts are the
`wc -l` totals and stand; the arms' NOTES numbers are code-only on
different bases (TanStack's "~3,300" is its 3,270 code-only count; hand's
3,237 excluded UI files; MobX's 2,484 included its README). All three are
openly over the 800–1,500 budget. Ruling: the budget was set before the
rule surface (decay windows, spin-off graph, rescue chains, fold grace,
prefix containment, defensive reads — ~370–570 lines of `rules.ts` in every
arm) was known, and every arm carries it independently. **Do not compress
in M2**: compression now means dropping parity-exact rules or merging
queries the criteria require to be separate. Revisit after the K-phase
change exercise prices growth instead.

**Q-M2 — MobX guarded-recursion divergence.** Accept the documented
least-fixpoint semantics. Evidence: forest structure, 0 `parentId` cycles
probed, 0 eligible-but-flat-false rows with agent-only descendants — the
divergence shape does not occur in the corpus, and the guard reads
in-progress rows as invisible instead of throwing. Fund the
subscription-complete variant only if a corpus ever exhibits the shape.

**Q-H3/M3/T3 — one counter: split classification from derivation?** Keep
current placement. The three arms' post-gate body counts coincide (3/3 on
scenarios 2–3), which is what I-phase needs for comparability. Ruling for
I-phase: compare **rows-committed** cross-arm as the primary metric;
`rollupsDerived` is arm-relative. No re-instrumentation required.

**Q-H5/M4 — defensive wire reads (spec gap, not arm defect).** Both arms
read fields absent from `SliceIssue` but present on real rows
(`branch`/`gitState`/`name`/`busy`/`supersededBy`/`duplicateOf`/
`dependents`) because parity requires it (merge decisions, draft titles).
Route to coordinator/architect: either grow the slice type or bless
defensive reading in the spec. No arm changes.

**Q-H4 — engine-driven selection invisibility.** Confirmed as designed:
locals-only publications emit no `RowSourceEvent`, so scenario #3's "2 rows"
manifests only on the UI click path (hand `hand.ui.test.tsx`, MobX
`mobx.ui.test.tsx:180`, TanStack `tanstack.ui.test.tsx` — all assert 2
rows / 0 derivations). I-phase probes must assert #3 on the mounted path,
not the engine path, in every arm.

**Q-T2 (coordinator addendum) — rollup seat mirroring: one mechanism or
two?** One mechanism with two reads — PASS. Ownership is decided once, in
the queries (`resolveQ` joinKey + verdict joins); the rollup mirrors
`verdict.owner` into `memberSeats`/`sidOwner` (`rollup.ts:770-835`),
value-compares everything out (`rewrite` :544-562, `refreshChain`
early-stop :584-599), and converges within the flush. The sharp half is the
proactive `dropSession` on `resolveQ` key moves (:186-199): a second *write*
path to the same seats that relies on the verdict re-seat following. It is
covered by the parity oracle plus the explicit-removal driving
(`takeRemoved` → `ingestIssue`/`dropSession`, `store.ts:231-240`), and any
divergence fails loudly as a parity diff — which is exactly the property
round one lacked. Direction to K-phase: aim exercise E (forgotten removal)
at the resolveKey-drop path.

**Q-T5 (coordinator addendum) — verdictR fan-out at shared worktrees.**
Exact on the fixture by parity; the fan-out is bounded by
issues-per-worktree (join on path equality, `queries.ts:537-554`), i.e. cost
follows the worktree's sharing degree, not the corpus. Growth-corpus
spot-checks stay a J-phase slope item, backed by the parity oracle at every
scale. Not a shape FAIL.

**Q-T4 — draft-title `firstPick` composite.** Pathological
(`name` containing `\x00` truncates on read-back); fixture + 1x verify
exact. Accept as documented; no action.

**F-H1 — REQUIRED follow-up (coordinator-owned, not a send-back).**
`packages/worklist-proto/tsconfig.json:4` includes `arms/mobx` and
`arms/tanstack` but **not `arms/hand`** (confirmed: no `arms/*/src`
directory exists; git shows each arm added its own folder and hand never
did). The hand arm's non-test sources are therefore outside the typecheck
gate — its core "the compiler refuses an unhandled kind" claim is
unverified by CI (vitest transpiles without typechecking). The runtime half
is verified (rebuild oracle green per scenario, executed above), so the arm
passes — but land the one-line include fix and re-run the typecheck before
I-phase starts. MobX's Q6 is thus answered: yes, coordinator-owned fix.

**README "how to add a field" accuracy (traced for a `blocked` boolean):**
hand — accurate, all 13 places real; `rebuild.ts:56-60` verified to reuse
the computes with `nullStats`. MobX — accurate, all 8 places real, late-read
guidance matches the code. TanStack — accurate, all 7 places real. Two
nits: hand's README claims "tick-adjacent case per set" in `hand.test.ts`
but **no clock-advance test exists yet** in any hand test file (scenario 8
is I-phase; only TanStack has `setCoarseNow` coverage at
`tanstack.test.ts:503`) — fix the sentence. TanStack's README omits the
interface updates (`SummaryRow`/`RowsRow`/`RollupRow`), which the compiler
enforces anyway via typed literals in all three arms' assembly points
(`rows.ts:27`, `models/issue.ts:358`, `store.ts:338`) — a strength worth
stating, not a gap.

**Hand-maintained lists per arm:** hand — delta union (compiler-checked) +
3 sensitivity sets + `runLevels` order + `notifyBatch` key mapping +
rebuild construction order (6 items, oracle/never/fence-covered). MobX —
12 bucket maps on one shared ingest path (update/replace/bootstrap share
`ingest*`) + 3 equality annotations (oracle+fence-covered). TanStack — 14
query definitions with `gcTime`+`getKey`, 9 `createIndex` calls, 3
`takeRemoved` drains, 19-entry disposal order.

## 5. Residual risks for the I-phase workers (per arm)

- Hand: R-H1's O(visible) scans will show up in the growth slope first;
  consider a `Set` for order membership when the slope says so. Clear
  R-H2. Harden R-H3.
- MobX: `moveSeat` full-map scans (R-M1) are the slope risk; the
  observation-driven counters mean bare-store tests can show 0 while
  mounted tests show N — always assert counts mounted.
- TanStack: gate or memoize the every-cycle `rebuildOrder` (R-T1) before
  reading too much into heartbeat walls; watch `dependentsOf` scan on
  evict-heavy scenarios; the 312 KB / 86 KB-gzip bundle delta stands as a
  decision input. Cross-arm `rollupsDerived` is not comparable (7-vs-3
  decomposition in §3–4); rows-committed is.

## 6. Criterion tick-off

- [x] This document has one checklist table per arm (§1a–1c), PASS/FAIL per
  line, no FAILs (hence no FAIL file:lines), and a verdict per arm.
- [x] No FAIL arm → no send-backs, no stage changes, I-phase issues
  unblock on shape. (Vacuously satisfied; stated explicitly so it is not
  read as skipped.)
- [x] Lines-excluding-tests, hand-maintained lists, README add-field
  accuracy recorded per arm (§4).
- [x] Document attached to this issue and to POD-4441; coordinator mailed
  with the three verdicts (see handoff).
- [x] Reviewer built none of the three arms (stated above).
