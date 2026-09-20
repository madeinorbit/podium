# POD-4286 — Prototype round two: the shape that makes today's problems hard to repeat

Status: proposal, revision 2 · 2026-09-20 · reviewed against `integrate/4286-frontend-perf` @
`717785d52`, `dev/mw` @ `6645cc283`, `main` @ `692d8c8e8`.
Written for someone who did not follow round one. Terms are explained where first used.

## 1. The answer in four sentences

Round one compared three copies of the same design, so it could only measure how much each
library charges for bookkeeping, and the cheapest bookkeeping won. The design itself is what
is slow and what is unsafe: one whole-corpus worklist calculation with a hand-maintained input
list, consumed by a list where every row re-renders. The goal you stated, a system where these
problems are hard to have again, is a property of the *shape*, and only one of the three
candidates can give that shape by construction: a tracked object graph (the Linear shape),
where a derivation is correct because it read observable state, not because someone
remembered to list its inputs. Round two should therefore build that shape once, properly,
with the safety enforcement switched on, and measure it against the current store; the
hand-written and TanStack arms are not candidates for the safety goal and should not be built
again at full scope.

## 2. What is actually slow today

Numbers are from the post-Phase-B live capture (`docs/measurements/POD-4358-post-b-baseline.md`,
4,887 issues / 4,323 sessions / 211 visible rows, Chromium, production build). Phase B is on
`dev/mw`.

| Window | Publishes | Subscriber wakes | Worklist derives | Switch p50 / p95 |
|---|---:|---:|---:|---:|
| Connected idle, 66 s | 28 | 7,840 | 1 (90 ms) | — |
| Ordinary activity, 66 s | 30 | 8,400 | 1 (57 ms) | — |
| Warm switching, 14 clicks in 51 s | 68 | 20,071 | 28 (4,098 ms) | 1,047 / 4,471 ms |
| Cold switching, 30 clicks in 136 s | 195 | 76,206 | 75 (9,676 ms) | 1,172 / 1,960 ms |

**Idle is solved.** The "eight seconds of rebuilding per minute" in the earlier summary was the
pre-Phase-B app. It is now one derive per minute on the clock tick.

**The switch is the problem, and it is not mainly the store.** Per warm click: about 5
publications, ~1,400 subscriber checks, 2 whole-corpus worklist derives (~290 ms), and about
1.6 s of React render. Largest self-time frames in the warm profile, per 14 clicks:

| Frame | Self ms | What it is |
|---|---:|---|
| garbage collector | 3,932 | allocation churn from the rows below |
| IndexedDB `requestAsPromise` | 2,347 | transcript load on switch (legitimate) |
| `getBoundingClientRect` | 1,658 | layout reads during render |
| `mission.ts` (`missionRootFor`, `byId`, `computeMissionIssueIds`, …) | ~4,000 | mission walks that rebuild an all-issues map per call |
| `UnifiedIssueRow` + `origin` | 943 | 211 rows re-rendered per click |
| `issue-chip-liveness` | 897 | a signature over all 4,887 issues per transcript render |
| `buildUnifiedRows` | 318 | the worklist derive proper |

### The read path in one paragraph

One snapshot object with every collection; one listener set; `apply()` computes the changed
keys and throws them away before notifying everyone (`engine/runtime.ts:884-891`). The worklist
slice re-derives when any of six collection identities moves (`sessions` moves on every session
delta because `dedupeSessions` allocates a fresh array) and returns a fresh object with no
equality guard, so its six readers re-render. Selection is one of the six inputs, so a click
rebuilds the world. The web sidebar renders all visible rows with no windowing and no
`React.memo`; each row receives the whole `issues` and `sessions` arrays as props and does its
own O(issues) scans. Mobile virtualises and memoizes rows but passes the same whole arrays, so
its own comment concedes the memo is defeated on every tick. The one per-entity cache in the
tree, `replica/issue-view-cache.ts`, is keyed on snapshot identity for evict and rescope safety.

## 3. Why round one proved nothing

The pilot (D2–E7) and the three-way comparison (POD-4403) all implemented the same
`PresentationModel` interface with the same `readWorklist()` body: enumerate every issue,
rebuild every issue model, run the shared builders, return a fresh slice. Compare
`presentation/model.ts:234-268` with `proofs/mobx-presentation/mobx-model.ts:359-393`; they are
the same function. So the arms differed only in how they *tracked* dependencies for a
calculation that depends on everything:

- The hand-written arm dirties one cell and recomputes lazily. Cheapest bookkeeping.
- The MobX arm wrapped ~15,000 rows in observables, marked every computed `keepAlive: true`
  (MobX's docs warn against it), and put the whole worklist under one computed. Every publish
  re-validated a graph of tens of thousands of nodes. A misuse, not a measurement of MobX.
- The TanStack arm re-read every coarse cell per publish.

The acceptance run (F1) then wired the pilot to the existing consumers unchanged: the
`useReplicaIssues` tail subscribed 14,601 cells in one component and a principal switch became
285 million cache reads (POD-4411); the unguarded `readWorklist` cost 380–620 ms per dirty read
(POD-4410). Neither is a property of any library.

The first D1 proof (`proofs/d1/mobx.tsx`, 76 lines) had the right shape: an observable per row,
a computed per summary, `observer` rows, zero unrelated reads. It ran only on a 200-issue toy
group and the production-scope arms did not carry it forward.

Keep from round one: the one-mutation-owner seam (kernel → effective post-optimism rows → read
model), the parity suite and counts-first method, the silent-failure exercise, the live-scale
fixture and the kernel scenarios.

## 4. Do we have the right shape? The foot-gun test

Your goal is not a faster worklist; it is a frontend where the class of problem we just spent
three weeks on is hard to create. So the question to ask of a shape is: *which mistakes does it
make impossible, which does it make loud, and which stay silent?*

### 4.1 Today's foot-guns, named

| Foot-gun | Instance in the code | Failure when someone slips |
|---|---|---|
| A derivation declares its inputs by hand | `worklistSlice.sourceEqual` lists six fields (`published.ts:185-205`); the pilot's `WORKLIST_INPUTS`; the cell input lists in `presentation/model.ts` | Forgotten input: silent stale screen, every test green (proved in POD-4403 for all three arms) |
| Invalidation at collection granularity | `sessions !== sessions` triggers a whole-world derive | Any heartbeat rebuilds everything; the fix is another hand-written guard |
| Whole-array props | `renderWorkRow` passes `issues` and `sessions` to every row | Memo cannot work; a new field added to a row multiplies its cost by 211 |
| Deriving inside render over the corpus | `missionRootFor` in `Workspace.tsx:780`, `issues.find` in `UnifiedIssueRow.tsx:168`, chip signature | A component author cannot tell an O(1) read from an O(N) one; nothing warns |
| Identity-keyed caches that miss together | `issueModelsBySnapshot`, `sessionIndexes`, `missionMemberSets`, `sessionSliceLookups` all keyed on the array | One allocation upstream (`dedupeSessions`) defeats four caches nobody sees |
| Five places that derive | store slices, view-models, per-component `useMemo`, the replica view cache, the presentation model | A new feature picks one at random; no rule says which |

None of these is a bug. Each is the design working as built. That is why "fix it again" is not
the plan.

### 4.2 The property we want

A derivation is correct **by construction** if it reads only tracked state, and a component
re-renders **only** for the state it read. Then:

- there is no input list to forget (the tracker records what was read);
- invalidation is at the granularity of what was read (a session's `lastActiveAt`, not "the
  sessions array");
- a row component that reads `issue.title` and `issue.phase` is not touched by any other field;
- an O(N) read inside a component is still possible, but it is visible: it reads N things, and
  the isolation fence in the test suite (rows committed ≤ rows affected) fails loudly.

This is the Linear shape: an object graph of models with observable fields and computed
getters, relations resolved through the graph (`issue.children`, `issue.sessions`,
`session.issue`), a sync engine as the only writer, `observer` components, and virtualised
lists. It is one model layer, not five.

### 4.3 How the three candidates score on the property

| | Hand-written keyed store | TanStack DB | MobX object graph |
|---|---|---|---|
| Dependency discovery | None. Every cell declares inputs; omission is silent. This *is* today's foot-gun rebuilt with smaller cells. | Automatic inside a query; manual for everything procedural (rollups, nesting, provenance), which is two thirds of the worklist | Automatic for everything read through an observable |
| Granularity | Whatever the author declared | Per query result (a new array per change to that query) | Per property |
| Row isolation | By discipline | Needs one live query per row; measured 10× heap and 20–30× bootstrap in D1 | Native (`observer`) |
| What stays silent | Unlisted input; missed release on evict | Misrouted staging; a memo that heals on read but never wakes | Untracked state (a plain variable where an observable belongs); a read outside a reaction |
| What can be made loud | Mutation oracles for *listed* inputs only | Nothing for the routing omission | `enforceActions: 'always'`, `computedRequiresReaction`, `observableRequiresReaction`, `reactionRequiresObservable` turn every silent case in the table into a thrown error or a console warning; `eslint-plugin-mobx` (`missing-observer`, `exhaustive-make-observable`) covers the component and model side |
| Cost of a new derived field | Type, staging list, input inventory, validator, read, inventory test (6 places, POD-4403) | 6 places incl. a second namespace list | A getter (1 place) |

The hand-written arm cannot deliver the property without becoming a tracking runtime, which is
MobX written at home. TanStack DB delivers it only for the relational third. MobX delivers it,
and its silent cases each have an enforcement switch.

So: **the shape in the earlier revision of this document was right on performance and wrong on
safety.** It framed a substrate-neutral hooks contract that the three arms would implement.
That is fair, but it keeps the read model as a layer beside the store with a hand-drawn
interface, and it lets the hand-written arm compete on a criterion it cannot meet. The round-two
shape is the object graph itself, and the candidate is the one substrate that can build it.

### 4.4 What MobX does not solve, said plainly

- **Indexes.** `issue.children`, `issue.sessions`, `worktree.sessions` need maintained maps.
  In an object graph they live in the store's write path (one `runInAction` per publication
  updates the row and the index buckets). MobX makes reading them tracked; it does not write them.
- **Subtree rollups and provenance walks.** Computed getters over `children` and `parent`
  express them naturally and invalidate along the chain; the code is still ours.
- **Scale discipline.** A computed that reads all 4,887 issues is still a whole-world computed.
  The guard is the isolation fence in tests and a lint against enumerating a table inside a
  component.
- **Lifecycle.** Computeds suspend when unobserved; a fresh store per principal handles
  sign-out; evict is `map.delete`, and every computed that read the row re-evaluates to
  undefined. Simpler than the keyed design's explicit release, but it must be proved under the
  D6 lifecycle contracts.
- **Optimism.** Stays in the kernel; the graph receives effective rows. Moving optimism onto the
  graph is a later decision, not round two.

## 5. What to build

### 5.1 The candidate: a MobX model layer for the worklist path, built the Linear way

- `packages/client-core/src/model/` (new, no dependency on `presentation/*`): `IssueModel`,
  `SessionModel`, `RepoModel`, `WorktreeModel` with observable fields fed from effective rows;
  `ModelStore` per principal holding shallow observable maps and the relation buckets; computed
  getters on the models for summary, rollup, continuation, band; `WorklistModel` with a computed
  visible set and computed groups over it.
- One `runInAction` per effective publication. The kernel remains the only writer.
- `configure({ enforceActions: 'always', computedRequiresReaction: true, observableRequiresReaction: true, reactionRequiresObservable: true })` in dev and test. No `keepAlive`.
- `observer` row, group and list components reading the models directly; the list parent reads
  `worklist.groups` only. Web list windowed with `@tanstack/react-virtual` (mobile already
  virtualises).
- A lint pass: `eslint-plugin-mobx` rules on, and a repo rule that no component enumerates a
  table (`store.issues.values()`) outside the model layer.

### 5.2 The control: the current store

The current store, unchanged, is the control arm. The isolation fence (rows committed ≤ rows
affected on an unrelated heartbeat) must fail on it, which proves the detector.

### 5.3 What is not built again

- **Hand-written keyed arm.** Its cost profile is known from D7 (cheapest bookkeeping) and its
  safety profile from POD-4403 (silent omission, six places per change). Building it at the new
  shape would only re-prove both.
- **TanStack DB arm.** Lost twice on per-reader cost, per-query reactivity is the wrong
  granularity for row isolation, and the retirement of the legacy adapter is already decided.
- If you want a second candidate for insurance, it should be another tracking runtime (Legend
  State v3, or `@preact/signals`), not a hand-rolled one, and it should be a bounded
  milestone-1-only build.

### 5.4 Fixed ground so the measurement is fair

- **Stage 0 first** (§7): the store-independent fixes land before the candidate is timed.
- **Fixture** = the live-shaped synthetic corpus (4,867 / 4,304) *with* the 500-repo /
  468-worktree tree; the empty tree in POD-4403 hid the nav-tree cost. Plus the 674 ci corpus.
- **Browser, not happy-dom.** Chromium via CDP, production build, input-to-paint for the click,
  long-task accounting, heap endpoints. happy-dom for counts in CI.
- **Counts first, walls second.** Rows committed, computed re-evaluations, reactions run, index
  bucket updates; walls interleaved with arm order rotated and load recorded, under the bench
  lease.
- **Parity oracle** after every scenario: visible row ids, order, per-row text, group
  membership identical to the control.

### 5.5 Scenarios and budgets

| # | Scenario | Rows committed | Computed re-evaluations | Wall |
|---|---|---|---|---|
| 1 | Unrelated session heartbeat | 0 | 0 | publish ≤ 2 ms |
| 2 | Session on a visible row changes phase | 1 (+ ancestors if rollup changes) | that chain | ≤ 8 ms |
| 3 | Selection click | 2 | 0 | input→paint p95 ≤ 100 ms |
| 4 | Title rename on a visible row | 1 | 1 | ≤ 8 ms |
| 5 | Stage change moving a row across groups | affected rows + order | chain + order | ≤ 16 ms |
| 6 | New issue / archive / authority evict without revision | order + row | bounded | ≤ 16 ms |
| 7 | Parent reassignment | both chains | both chains | ≤ 16 ms |
| 8 | Coarse clock tick | rows whose band moved | bands | ≤ 8 ms |
| 9 | Optimistic echo and rejection | as 2 | as 2 | no full rebuild |
| 10 | 50-event burst through `batch()` | bounded | bounded | one action |
| 11 | Principal switch over a fresh replica | full, once | full, once | ≤ 2× control |
| 12 | Cold bootstrap at live corpus | full, once | full, once | ≤ 1.1× control; heap ≤ 1.1× |
| 13 | Rescope growth then back | full, once each | full | no leak after disposal |

Scenarios 1–3 are milestone 1 and the kill gate.

### 5.6 The foot-gun exercise, which is the point

Done by a developer (or agent) who did not build the model layer, on the candidate and on the
control, counting files, lines and places-to-remember and recording what the screen shows:

- A: add a new input that affects row placement.
- B: add a new derived field to the row.
- C: change the bubbling rule ("an ask on any descendant marks the root asking").
- D: omit the plausible bookkeeping step in each (control: leave the input out of
  `sourceEqual`; candidate: store the input in a plain variable). Expected: control silent;
  candidate throws under `observableRequiresReaction` / the isolation fence fails.
- E: forget to remove a row from an index on evict. Expected: candidate's parity oracle fails on
  scenario 6.
- F: write an O(N) read inside a row component. Expected: isolation fence fails.

The decision document leads with this table, not with walls.

### 5.7 Milestones

| M | Deliverable | Gate |
|---|---|---|
| 0 | Stage 0 fixes landed and remeasured; cruft removed from `dev/mw`; browser harness with the live-shaped fixture; control fails the isolation fence | harness produces counts and paint times |
| 1 | Model layer: tables, relations, per-issue computeds, `WorklistModel`; observer components; scenarios 1–3 | kill gate |
| 2 | Scenarios 4–10 | budgets or a named reason |
| 3 | Lifecycle 11–13, mobile `WorkScreen` on the models, bundle and heap | budgets |
| 4 | Foot-gun exercise, complexity report, decision document, and the migration order for the rest of the app if adopted | a decision the operator can read cold |

Rough sizes with one lane per milestone: M0 about a week (mostly Stage 0), M1 three to four
days, M2 a week, M3 three to four days, M4 a week. About four weeks of lane time.

## 6. What this changes in the epic

- F2–F4 stay blocked; they assumed a pilot that passed F1.
- The shipped pilot (`presentation/*`, effective-changes, E1–E7 consumers, the flag) is not the
  base for round two and is removed from `dev/mw` (§7). Its tests and the lifecycle contracts
  (D6) are reused as specifications.
- The C1 gate outcome 4 stands; its definition of the pilot is replaced by §5.

## 7. Stage 0 and the landing plan

### 7.1 Where the code is

`dev/mw` already contains the integration branch up to the E4 WIP commit (`6c578b31c`): Phase
A and B, the D1/D7 proofs, the effective-changes contract, the presentation model, and the
`mobx` / `@tanstack/db 0.9.2` pins. Only 72 commits remain on `integrate/4286-frontend-perf`:
E1/E5/E6 consumers, the 4394/4399 worklist tails, the F1 harness, the 4410/4411 probes, the
4403 arms and bench, and three real fixes.

### 7.2 Salvage from the integration branch (cherry-pick onto a branch off `dev/mw`)

| Commit | Keep | Why |
|---|---|---|
| `097abcbd5` + `49317693a` (4378) | yes | retires dead file records after prune grace; a runtime fix |
| `905ee439e` + `12f4d5bfd` (4382), `replica/issue-views.ts` half only | yes | live sessions counted as `unknown` phase; the `presentation/` half goes with the pilot |
| `717785d52` (C2 verdict), `df1de1d0f` (F1 report), `9de88e917`/`9c50a3514` (4410/4411 diagnoses), `e158aa6fa` + `35f9376e9` (4403 document and results JSON) | docs only | evidence; no code |
| everything else (E1/E5/E6, 4394, 4399, F1 harness, 4403 arms, probes) | no | prototype cruft |

Then retire the integration branch.

### 7.3 Remove from `dev/mw` (a branch off `dev/mw`, landed with the operator's go-ahead)

- `packages/client-core/src/presentation/*`, `react/presentation.test.tsx`
- `engine/effective-changes.ts`, `engine/effective-view.ts`, their tests, and the hooks into
  `optimism.ts`, `runtime.ts`, `react/provider.tsx` (keep the addressed replica batches through
  the binding, `5ade60a99`/`7d1b97c17`, only if a test other than the pilot's depends on them;
  otherwise remove)
- `packages/client-core/proofs/d1/*`, `apps/web/src/perf/d1-reactivity.test.tsx`, the perf
  config include, `turbo.json` proof tasks, `apps/server/turbo.json` if pilot-related
- `mobx` and `mobx-react-lite` pins (round two re-adds them deliberately, in the model package)
- `@tanstack/db` 0.9.2 / companion 0.2.23 / `react-db` 0.4.1: keep only if the legacy adapter's
  own tests pass on the bump; otherwise revert to the `main` pins. The retirement plan owns the
  eventual deletion.
- `docs/plans/pod-4322/4325/4328` stay as history; `docs/measurements/*.json` from proofs stay.

### 7.4 Stage 0 fixes (each its own sub-issue, each independently releasable, each with before/after counts from the post-B collector)

| # | Fix | Where | Expected effect |
|---|---|---|---|
| S1 | Mission root and member index once per issues array (WeakMap), used by every `missionRootFor` / `missionIssueIds` caller | `viewmodels/mission.ts:388`, callers in `engine/state.ts`, `reactions.ts`, `runtime.ts`, `Workspace.tsx`, `use-unified-work.ts`, mobile screens | removes ~4 s of the 14-click warm profile |
| S2 | Selection out of the worklist derive; latch and group placement as a cheap post-pass over the derived output | `slices/worklist/published.ts:191`, `folds.ts` | 2 derives per click → 0 |
| S3 | Memoized rows with narrow props; row-local lookups moved into the derived row (origin issue, display title); mobile `WorkRow` the same | `SidebarUnified.tsx` `renderWorkRow`, `UnifiedIssueRow.tsx`, `WorkScreen.tsx:670` | 211 row renders per publish → rows whose row object changed |
| S4 | Issue chip signature memoized on the issues array identity | `apps/web/src/lib/issue-chip-liveness.ts`, `IssueChipLiveness.tsx` | ~0.9 s per 14 clicks |
| S5 | One publication per click: fold mark-read optimism, visit baseline and the machines echo into the navigation batch | `use-unified-work.ts:206-231`, `runtime.ts` reactions | ~5 publishes per click → 1 + the network echo |
| S6 | Layout-read hotspot on switch (`getBoundingClientRect`, 1.7 s per 14 clicks): find the reader, batch or remove | unknown until profiled | measured, then fixed or filed |
| S7 | Post-fix live remeasure with the C1 collector; freeze as the round-two control baseline | `docs/measurements/` | the baseline round two is judged against |

## 8. Source anchors

Live evidence: `docs/measurements/POD-4358-post-b-baseline.md`, `POD-4358-post-b-live.json`,
`POD-4286-gate-a.md`. Round one: `docs/decisions/4321-reactive-pilot.md`,
`4364-keyed-store-comparison.md`, `4403-three-way-store-comparison.md`;
`docs/measurements/POD-4332-f1-acceptance.md`, `POD-4410-publish-path.md`,
`POD-4411-principal-switch.md`. Shapes compared: `packages/client-core/src/presentation/model.ts:234-268`
vs `packages/client-core/proofs/mobx-presentation/mobx-model.ts:359-393`; per-row proof at
`packages/client-core/proofs/d1/mobx.tsx`. Current read path: `packages/client-core/src/store.ts:49-63`,
`engine/runtime.ts:872-892`, `viewmodels/slices/worklist/published.ts:164-241`,
`slices/worklist/rows.ts:51-231`, `viewmodels/mission.ts:388`, `replica/issue-view-cache.ts:250-300`,
`apps/web/src/features/worklist/SidebarUnified.tsx:840-940`, `UnifiedIssueRow.tsx:118-230`,
`apps/mobile/src/screens/WorkScreen.tsx:203,398,664-670`. MobX enforcement: `configure` options
and `eslint-plugin-mobx` rules as named in §4.3 (verify against the pinned 7.0.3 docs before use).
