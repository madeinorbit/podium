# K2 MobX arm exercise (`POD-4457`)

I did not build this arm. I read only `packages/worklist-proto/arms/mobx/README.md`
before opening any code in the arm, formed written expectations of where each
change would go (recorded in §5), then read the code. All changes and omissions
below were implemented on throwaway branches (`k2a-snooze`, `k2b-continuation`,
`k2c-bubble`, `k2c2-lanes`, `k2d-plaingate`, `k2e-evict`, `k2f-rowscan`),
verified, saved as diffs under `docs/decisions/4441-k-mobx-diffs/`, and reverted.
The arm is byte-identical to before (`git status` clean on
`packages/worklist-proto/arms/mobx/`); its tests are green after the revert (§8).
Load was 11–20 for the whole exercise, so every verdict below rests on counts,
not walls (methodology §5.7).

## Table 1 — changes (A/B/C/C2)

| Change | Files touched | Lines +/− | Places you must remember (clean-tip file:line) | First-attempt parity | First-attempt fence | What told you when it failed | Time |
|---|---|---|---|---|---|---|---|
| A snooze: `snoozedUntil` hides the row while `coarseNow` is before it; reappears on the passing tick | `rules.ts`, `models/issue.ts` | +29/−0 | `rules.ts:348` (predicate after `returnedFromDefer`); `models/issue.ts:19` (import), `:153` (`flat` gate) | PASS (fixture parity green first try — no corpus row carries the field) | corrected once: expected 1 commit, got 0 | the failing assertion + `RowShell` design (mount/unmount commits excluded) → fence reads 0, `rowsDerived` exactly 1 both directions | ~40 min |
| B continuation walk: legacy `issueContinuation` (mission.ts:2207) as a derived line | `store.ts`, `models/issue.ts`, `react/list.tsx` | +57/−0 | `store.ts:792` (`continuationOf` neighbour); `models/issue.ts:288` (`tick` neighbour + `makeObservable` entries `:84,:95`); `react/list.tsx:35` (tick render neighbour) | PASS (fixture parity green first try — the line rides beside the snapshot, never enters `SliceRow`) | PASS (setting `supersededBy` commits exactly the row, `rowsDerived` exactly 1) | a real `typecheck` failure first (TS2353: private `displayRefOf` missing from the `makeObservable` annotation map — inlined as a closure instead) | ~45 min |
| C bubbling: an ask on any descendant marks the root asking | `models/issue.ts` | +15/−0 | `models/issue.ts:233` (`aggregate`, formal-subtree loop beside `visibleSubtree`) | PASS (fixture + m2 parity green first try — corpus has no invisible-but-edged asker) | PASS (archive-detach control: asking true→false, exactly the root commits) | n/a (probe green first try) | ~40 min |
| C2 worktree rows: a lane with sessions but no issue rows in the same list and groups | `models/lane.ts` (new, 121), `store.ts`, `worklist.ts`, `react/list.tsx`, `native/list.tsx` (5 files) | +226/−10 | `models/lane.ts` (whole file); `store.ts:89` (laneModels decl), `:585` (`ingestWorktree`), `:712,:725` (`laneSessions`/`liveIssuesAt`), `:872` (`snapshot`), `:901` (`dispose`); `worklist.ts:37` (`visibleIds`), `:54` (`order`), `:72` (`groups`), `:115` (`laneOf`); `react/list.tsx:163`, `native/list.tsx:72` (row lookups) | FAIL by design: exactly 37 extra lane rows at fixture 1x (`lane:/w/*`), 0 missing, 0 changed issue rows (§4) | PASS (lane flip commits exactly the lane row, `rowsDerived` 1, `rollupsDerived` 0; absorb removes it with `rowsDerived` 2) | the classify probe (extra=37/missing=0/changed=0) | ~75 min |

## Table 2 — foot-guns (D/E/F), each run with enforcement ON and OFF

| Gun | What the screen showed | What fired (named) or SILENT | ON vs OFF | How long until a developer notices |
|---|---|---|---|---|
| D omitted bookkeeping in the arm's idiom: new input in a plain module variable (`k2dSnoozeGate`) read by `flat` | snoozed row stays visible after the gate flips (stale screen, self-consistent) | FIRED: only the intended-behavior probe (`k2d-probe.test.tsx`, both tests fail with `['A']` vs `[]`). SILENT: `typecheck`, arm `eslint.config.mjs` (`missing-observer` + `exhaustive-make-observable`, clean), fixture parity, all existing arm tests | identical: stale under ON and OFF; no MobX warning fires in either (a plain read is not an observable read — there is nothing to warn about) | indefinite without a behavior test on a snooze-shaped corpus; the next unrelated invalidation heals it silently, hiding the evidence |
| E index not cleaned on eviction: orphan block + session-seat deletes removed from `ingestIssue` | correct screen, no ghost (every read guards on the tables) — but `parentOf.get('B')` stays `'A'` after evicting A | FIRED: existing unit test `mobx arm: locals + lifecycle > removal disposes buckets; dispose detaches and clears` (`mobx.test.ts:375`, `expected 'A' to be undefined`) + the `k2e` probe's bucket assertion. SILENT: `typecheck`, eslint, fixture parity, m2 gate (values + counts), rendered output | identical ON/OFF (plain map ops in actions; enforcement has nothing to say) | immediate in unit tests; in the wild, never via the screen — only a bucket-level assertion or a leak hunt finds it |
| F O(N) read inside the row component (`for (const [, m] of store.issues) … m.row` in `MobxRowView`) | identical screen, identical snapshot, S's row object identical (`toBe`) | FIRED: the exact-commit assertions — depth-3 commits `{C,L,P,R}` become `{C,L,P,R,S:1}` (5 commits, `rowsDerived` stays 4). SILENT: `typecheck`, eslint (`missing-observer` satisfied — the component IS `observer`), fixture parity, `mobx.test.ts` values | identical ON/OFF; the amplification is observer mechanics, not enforcement | immediate wherever an exact-commit assertion covers a subtree change; otherwise only a wall-clock profile or the 2x/4x slope (per-commit CPU is still invisible — see §6.1) |

## Table 3 — complexity

| Item | Value |
|---|---|
| Implementation lines, tests excluded | 2,516 (11 files: `store.ts` 940, `rules.ts` 571, `models/issue.ts` 488, `react/list.tsx` 187, `worklist.ts` 136, `native/list.tsx` 78, `arm.ts` 50, `config.ts` 25, `models/session.ts` 21, `models/worktree.ts` 20; + `eslint.config.mjs` 41, `README.md` 127, `NOTES.md` 269; tests 1,828 + spike). The "roughly half the hand arm" claim checks out within rounding: 2,516 vs 3,962 (0.64x). Largest files are the same faithful rule transcription + bucket ingest the hand arm carries |
| Concepts a reader must hold (all named from the code) | `observable.ref` borrowed rows; per-issue computeds (`excluded`/`flat`/`visible`/`summary`/`aggregate`/`tick`/`rankKey`/`closed`/`isSelected`/`row`); relation getters through buckets (`parent`/`children`/`sessions`/`origin` read the store, no intermediary identity); `computed` vs `computedStruct` vs shallow-equality list computeds (`visibleIds`/`order`/`groups`); read-as-late-as-possible clock subscription (`coarseNow` only on decay/defer paths); `visibleGuard` least-fixpoint recursion; `lastRowJson`/`lastTickJson` commit counters (`rowsDerived` = committed rows only); `MobxScanName` slope vocabulary beside `ArmStats`; `stats.reset()` + mount-excluded `RowShell` fence; `enforceActions: 'always'` + the three `*Requires*` flags; `makeObservable` annotation map (every member annotated); no `keepAlive` (suspension is correct) |
| Reading path I took | README → `rules.ts` → `models/issue.ts` → `store.ts` (write path, then indexes, then reads) → `worklist.ts` → `react/list.tsx` + `native/list.tsx` → `config.ts` + `arm.ts` → `mobx.test.ts` → `mobx.ui.test.tsx` → count harness → hand exercise + hand A diff → legacy `mission.ts:2207`, `row-attention.ts:116`, `slices/worklist/rows.ts:255` (rules only) |
| README accuracy | High: the "How to add a field" 5-step recipe predicted A/B touch-points; the 8-point "places to remember" list predicted every file all four changes touched (C2's new `models/lane.ts` is the documented "new derivations live here" case); the late-clock-read discipline told me exactly where the A subscription had to go. Two deductions: (1) the union-list problem, same as the hand arm — a newcomer cannot tell which subset a change needs (I wrongly expected `store.ts`/`worklist.ts` edits for A; none were needed); (2) the tick precedent for B lives in `models/issue.ts` + `react/list.tsx` but is NOT mentioned in the recipe — I found it by reading code, not the README. Minor, filed here, not fixed |

## §4 C2 parity classification (fail by design, measured not asserted)

The fixture corpus at 1x contains 37 lonely lanes (`lane:/w/276`, `/w/281`, …) —
unlike the hand exercise's fixture corpus, which had none. The classify probe
(boot fixture corpus, arm snapshot vs `snapshotFromStore`, deleted before the
diff was saved) reports `extra=37 missing=0 changed=0`, `allLane=true`. Every
issue row is byte-identical; the 37 lane rows are pure additions with their own
`lane:` namespace, so no id can collide with an issue row. The m2 gate fails on
the C2 branch for the same reason (lonely lanes in the growth corpus) — values
and counts on issue rows are unaffected. Inventions with no spec behind them,
recorded not defended (same three as the hand arm): lane displayRef
(`prefix ?? path tail`), lane title (`repoName`), lane rank (`createdAt ''`
sorts last in-band), group label (path tail).

## §5 Expectations (README-only) vs where things actually went

- A: expected rules + issue-model flat + maybe worklist/store. Wrong about
  store/worklist — no enumeration, bucket, or list change: `flat` returning
  false propagates through `visible`/`row`/`order`/`groups` with zero further
  code. The README's "read as late as possible" told me the clock guard had to
  be field-conditional; the probe proved non-carriers never subscribe
  (`plainTick`: 0 commits, 0 derivations on a +2h tick).
- B: expected a new computed beside `tick` + store rule + list render. Right
  in full — the tick is the documented-by-code precedent the README recipe
  omits (§Table 3). The legacy transcription is 1:1 (`continued · <ref>` /
  `duplicate · <ref>` / `another task`; vacated + spin-off tip), reusing the
  existing `spinOffTip`/`hasOpenExplicit` (the spinoff-line path shares the
  tested boolean's machinery; the probe covers superseded/duplicate/unknown).
  One genuine surprise: `typecheck` (TS2353) rejected a `private` helper
  missing from the `makeObservable` annotation map — the annotation discipline
  is load-bearing, not ceremonial.
- C: expected an aggregate ancestor walk. Right — one 15-line loop over the
  existing `formalMembers` inside `aggregate`, pushing invisible members' live
  sessions into the bubbled set. Pending decisions deliberately stay
  visible-subtree-only (the legacy attached-row walk). The archived-detach
  control mirrors the hand arm's finding 1:1 (archived children detach at
  ingest via `parentEdgeOf`; `proposed` stays edged and invisible — the shape
  that bubbles).
- C2: expected store bucket + worklist + models + both lists. Right about the
  scale (5 files, +226/−10, new `models/lane.ts`) and wrong that fixture
  parity would stay green — the fixture corpus here HAS lonely lanes (§4).

## §6 What the exercise surfaced beyond the diffs

1. **F is the decisive MobX-vs-hand difference the coordinator asked about.**
  The same mistake — O(N) read inside the row — is silent everywhere automated
  in the hand arm (commits `{A:1,B:1}` unchanged) but LOUD in MobX commit
  counts: depth-3 goes from 4 commits to 5, the untouched sibling S commits
  while its row object stays `toBe`-identical. Mechanism: the scan subscribes
  every `observer` row to every row's `row` computed, so one row's change
  re-renders all rows and the `RowShell` fence prices each re-render. Two
  qualifications that keep this honest rather than triumphal. First, what fires
  is the RENDER-commit log, not the derivation counters: `rowsDerived` stays 4
  and parity stays green, so a suite with only derivation-count and parity
  assertions (no exact `commitsByRow` assertion on a subtree change) is still
  blind. Second, per-commit CPU remains invisible: the fence counts commits,
  not work per commit — an F-variant that re-renders without committing (e.g.
  behind a memo boundary) would go quiet again. The harness prices WHAT
  re-rendered, never HOW MUCH it cost.
2. **Asymmetry verdict (the coordinator's question): agree from the MobX side
  — raise the hand arm, do not lower MobX.** The F finding is the proof: the
  exact-count assertion that caught F here (`{C,L,P,R}` in `mobx.ui.test.tsx`)
  is precisely the assertion the hand 1x test lacks. Had the MobX suite
  asserted parity + derivation counts only, F would have been silent here too.
  Add MobX-style exact `commitsByRow` assertions to the hand arm's 1x and
  subtree tests; the currency of the comparison is commits and every arm's
  native test should mint it.
3. **E is the mirror image: MobX indexes fail soft where the hand arm ghosts.**
  Deleting the eviction cleanup leaves the screen byte-correct (every bucket
  read guards on its table — `membersOf`, `readVisible`, `formalMembers`,
  `progressOf` all re-check `issues.get`), so unlike the hand arm there is no
  ghost row for a user to see. What catches it is the bucket-level unit test
  (`removal disposes buckets`, `mobx.test.ts:375`) — an assertion on the INDEX,
  not the screen. Lesson for the rewrite: index-bucket unit tests are not
  redundant with parity; they are the only tests that price the index. (The
  leak itself — stale `parentOf`/seats, unmeasured memory — is the long-tail
  cost neither suite prices.)
4. **D is silent in both arms' idioms, and MobX enforcement cannot change
  that.** The three `*Requires*` flags warn about observable reads outside
  reactions; a plain module variable is not an observable, so there is nothing
  to warn about — ON and OFF runs are identical, no warning in either. The
  hand arm's never-check at least fires at compile time when the kind is added
  unhandled (before the bypass); MobX has no declaration site for a new input
  at all, so there is not even a bypass to notice. The only detector is a
  behavior test on an input-shaped corpus — and the fixture corpus carries no
  such input, so parity stays green. If the rewrite chooses MobX, inputs that
  arrive as plain values (feature flags, module config) need a testing
  convention, because the framework provides none.
5. **A Small suspension footnote, verified not assumed.** `plainTick` on a
  carrier-free world derives exactly 0 bodies: non-carriers never subscribe to
  `coarseNow`. The subscription-completeness price (3,589 settled bodies per
  tick, per the arm's notes) is paid only by rows that actually read the
  clock — the mechanism is precise, not blanket.
6. **Process notes (own mistakes, for the record).** (a) One content-free edit
  concatenated two lines (`models/issue.ts` rankKey comment — the exact
  mistake class the hand author confesses); caught on re-read before any run.
  (b) One unclosed brace in `liveIssuesAt` from a too-small `oldString`;
  caught by the immediate re-read. (c) Two wrong probe expectations of my own
  (B's phase on a sessionless issue; exampleWorld's visible C) — both were my
  error, not the arm's; corrected, not hidden. (d) The first B commit went out
  with a typecheck failure I had run but misread (`tail -3` swallowed the
  error); from then on every validation output was grepped for `error TS`.

## §7 Claims check (coordinator's list, current tip)

- Counts flat across 1x/2x/4x: not re-measured (load 11–20 throughout;
  counts-only discipline). The m2 gate is green on the clean tip (this
  exercise, §8), which replays the 1x count assertions.
- Lifecycle proved, rescope to baseline: untouched by this exercise; per NOTES.md M3.
- Clock 3,589 settled bodies / 0 commits vs hand's 259: untouched; per
  `mobx.clock.test.tsx` (green in §8).
- Bundle 19.72 KB vs hand 11.21: not re-measured (no browser build in this exercise).
- Implementation roughly half the hand arm: confirmed with numbers — 2,516 vs
  3,962 implementation lines (0.64x), 11 files vs 15 (§Table 3).

## §8 Revert and green

After the last experiment every scratch branch was abandoned (commits remain in
branch history as the work log) and the issue branch holds only the record:
`git status` shows nothing under `packages/worklist-proto/arms/mobx/`; the
seven diffs live under `docs/decisions/4441-k-mobx-diffs/`. Focused suite green
after revert, run once at the end (load ~18, counts only): `bun run test:file
-- packages/worklist-proto/arms/mobx/mobx.test.ts mobx.ui.test.tsx
mobx.fixture.test.ts mobx.clock.test.tsx mobx.engine.test.tsx mobx.m2.test.tsx`
→ 6 files, 39 tests, all pass; `bun run typecheck -- --filter
@podium/worklist-proto` → 8 tasks successful. Not run: `mobx.1x.test.tsx` /
`mobx.m3.test.tsx` (growth-scale, reverted tree identical to the measured tip;
load forbids walls anyway) and the `bun run test` lean gate (may be red on
untouched files per the brief). A/B/C/C2 probes were deleted before their
diffs were saved; their assertions and numbers are transcribed in §§Table 1–2
and this section. D/E/F diffs keep their probe tests as the firing evidence.
