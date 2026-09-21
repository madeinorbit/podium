# POD-4447 NOTES — MobX arm, milestone 1

## Decisions

- **Tracked object graph, not a port.** Each issue is an `IssueModel` with
  observable `value` (`observable.ref`: the borrowed row, never spread) and
  computed getters (`flat`, `visible`, `summary`, `aggregate`, `tick`,
  `rankKey`, `closed`, `isSelected`, `row`); sessions and worktrees are leaf
  boxes. Relations run through the graph (`issue.parent/children/sessions/
  origin` read the store's buckets, so reads flow to the calling computed and
  no intermediary identity ever propagates spuriously). There is no
  whole-worklist computed and no `keepAlive` — the round-one mistakes, named
  in methodology §3, are absent by construction.
- **Read as late as possible.** Every computed checks cheap structural gates
  first and reads volatile fields and `coarseNow` only on paths that need
  them (defer carriers for bands, finished members for decay, settled rows
  for the fold grace and selection). MobX subscribes a computed only to what
  its body actually read, so the unrelated heartbeat invalidates nothing and
  a deep change re-runs exactly the ancestors until values settle
  (structural/shallow equality stops the propagation; sibling row objects
  keep identity — asserted with `toBe` in the depth-3 test).
- **Row-replacement granularity is inherent to the stream.** `apply` swaps
  the whole borrowed row object, so every computed that read the old object
  re-runs on any field change — even `readAt`-only mark-reads re-run the
  flat + summary + aggregate input checks (3 evaluations, zero value
  changes, zero commits). The hand arm counts the same 3 for the same input;
  the numbers coincide for the same reason.
- **Unread is derived, never trusted from the wire** (`derivedUnread`
  replays the replica rollup; archived sessions sit in explicit seats and are
  filtered at read — one seat system, two reads, same as the hand arm).
- **Awaiting-merge never fires; merge decisions never fire.** Both read
  `branch`/`gitState`, which the navigation model never carries — the arm
  matches legacy (spec: legacy wins over shorthand). Defensive reads
  (`busy`, `name`, `supersededBy`, `duplicateOf`) mirror the hand arm's open
  H4 question #5.
- **Engine rows omit open `closedReason` (undefined, not null).** Every
  finished check uses loose `!= null` (verified against the cited
  `session-status.ts:463` and `row-attention.ts:51`). Strict `!== null`
  failed SMALL parity on i7/i8/i9 (a finished+offerOnly misread plus phantom
  done units) — the oracle diff pinpointed it in one run.
- **Rescue/hosting is guarded recursion with least-fixpoint semantics.**
  Keeper edges point down, hosted edges point up; an evaluation-stack guard
  reads in-progress rows as invisible instead of throwing MobX's cycle
  error. On a forest this coincides with the iterative fixpoint. Fixture
  probe: 0 parentId cycles, and 0 eligible-but-flat-false rows with
  agent-only descendants — the theoretical divergence shape (an agent as a
  row's only keeper) does not occur in the corpus. Documented here, not
  hidden.
- **Snapshot is the unselected baseline in practice, live locals in code.**
  `snapshot()` reads live selection like the hand arm; every parity test
  holds selection null, so both match the oracle's `(null, false)`.
- **Derivation counters are observation-driven.** `rollupsDerived` counts
  `flat` + `summary` + `aggregate` body executions; `rowsDerived` counts
  committed rows (JSON-compared, removals included) plus tick rides;
  `indexUpdates` counts mutating bucket writes; `notifications` counts
  dispatches including no-ops. Unobserved computeds suspend, so count
  assertions live in mounted tests; bare-store tests assert values plus the
  eager counters. Bootstrap counts reset after construction.
- **Native renders full in a ScrollView for M1** (same as the hand arm and
  the control lane, so counts compare directly); the web list is windowed
  (fixed heights + overscan, full-render fallback at height 0 — no new
  windowing dependency, same call the hand arm made).
- **ESLint instead of the standard TS parser.** typescript-eslint refuses
  the repo's TypeScript 7 compiler and no TS-based parser can work with it
  (the Go compiler exports no parser API), so the folder-local flat config
  parses with Babel (7.x line — 8.x breaks JSX) and enforces the two mobx
  rules. Neither rule needs type information.

## Count tables

### 1x engine-backed (GROWTH_CORPORA.x1; 4,867 issues / 4,304 sessions / 500 repos; 3,230 visible rows; `mobx-1x-counts.json`, gitignored)

| Scenario | Rows committed | rowsDerived | rollupsDerived | indexUpdates | notifications | Parity |
|---|---|---|---|---|---|---|
| #1 unrelatedHeartbeat | 0 / 3230 | 0 | 0 | 0 | 1 | green |
| #2 visibleSessionPhaseChange | 1 (i0) | 1 | 3 | 0 | 1 | green |
| #3 selectionClick (engine path) | 0 | 0 | 3¹ | 0 | 1 | green |

¹ The eager mark-read row replaces i1's row object: its flat + summary +
aggregate input checks execute and prove zero value changes.

### UI click path (happy-dom, `mobx.ui.test.tsx`)

| Action | Rows committed | rowsDerived | rollupsDerived |
|---|---|---|---|
| setSelection A→B | 2 (A, B) | 0 | 0 |
| Phase change on B (chain A+B) | 2 (A, B) | 2 | 4² |
| Depth-3 change (chain L+C+P+R, S untouched³) | 4 | 4 | 6 |

² B: flat + summary + aggregate; A: aggregate only (A's flat/summary read
A's own sessions and never invalidate).
³ S's row object is identical before/after (`toBe`); the chain bodies are L's
flat + summary + aggregate plus one aggregate per ancestor.

### SMALL engine-backed

Identical shape at 37 visible rows: heartbeat 0/0/0/0, phase 1 (i0) + 1/3,
click 0 + 0/3, parity green throughout.

### G2 fixture at 1x (engine-booted, `mobx.fixture.test.ts`)

211 visible rows — full-snapshot deep-equal with `snapshotFromStore` (rows,
order, groups). The corpus the browser pages measure.

### Browser (1x click input-to-paint)

(Table lands with the bench lease; counts above are the verdict meanwhile.)

## Line count (arm folder, `wc -l`; tests excluded)

2,484 total / 1,954 code-only vs the 800–1,500 budget — OVER, openly.
Breakdown (total): rules 571, store 821, models/issue 460, react 187,
worklist 115, native 78, arm 50, config 25, session/worktree 41, README 95,
eslint config 41.

Where the weight is: the same faithful rule transcription the hand arm
carries (decay windows, spin-off tips, rescue, fold grace, prefix
containment, defensive wire reads), plus bucket ingest that mirrors the
hand arm's seat semantics. The MobX saving is real but partial: no delta
union, no level modules with apply/rebuild duplication, no rebuild oracle —
one computed path instead of incremental + from-scratch. Further compression
is comment-trimming and ingest-sharing, not structure — deferred to H4
review (open question 1 below, shared with the hand arm).

## Open questions for H4

1. Line budget vs fidelity (shared with the hand arm): is ~2,000–2,800
   lines acceptable for a parity-exact slice, or should M2 compress (and
   what may be dropped)? The MobX arm is ~30% smaller than the hand arm for
   identical parity.
2. The guarded-recursion divergence shape (agent as a row's only keeper):
   accept the documented least-fixpoint semantics, or fund the
   subscription-complete variant? No corpus occurrence found (probe above).
3. `rollupsDerived` semantics: flat + summary + aggregate bodies, matching
   the hand arm's classification. Keep, or split classification from
   derivation?
4. Defensive wire reads (`branch`, `gitState`, `name`, `busy`,
   `supersededBy`, `duplicateOf`) absent from `SliceIssue` but present on
   engine rows and required for parity — shared with the hand arm's
   question #5: grow the slice type or keep defensive reading?
5. Native windowing: ScrollView-full matches the control lane for M1;
   FlatList recycling deferred to M3 like the hand arm.
6. `packages/worklist-proto/tsconfig.json` `include` covers `arms/*/src`
   but not `arms/hand/*.ts` — the hand arm's non-test sources may not be
   typechecked at all. This arm adds its own folder (`arms/mobx`) to
   `include` and proves coverage (a type error there fails the gate).
   Worth a coordinator-owned fix for the other arms?
