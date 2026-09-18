# POD-4286 — Frontend state-store performance epic

Status: planning · 2026-09-18 · Supersedes the analysis in `~/podium-frontend-performance-epic-plan.md`
(reviewed against `89574f1c8`; 13 of its 14 anchor files are byte-identical at `692d8c8e8`).

## 1. What is actually slow, and why

The client store (`packages/client-core`) is one immutable snapshot object with ~200 top-level
fields (about 60 data fields, the rest action functions). The runtime's `apply()` writes a patch,
builds a **fresh snapshot object**, notifies **every** subscriber, then runs the reaction table.
Subscribers are `useSyncExternalStore` bindings: 193 `useStoreSelector` sites (web 167, mobile 22),
8 `useSlice` readers over exactly **two** published slices (`worklist`, `superagent`), 30
`useReplicaIssues` readers, and 13 whole-store `useStore()` reads on mobile (none on web).

The hypothesis "the store has no slices" is half right. A slice mechanism exists
(`viewmodels/slices/publish.ts`: `defineSlice` + `sourceEqual` dependency guard), but only the
worklist uses it, and it guards at **collection identity** granularity. Nothing tracks
dependencies at entity granularity, and the runtime computes the set of changed top-level keys
on every `apply()` and then discards it one line before the fan-out.

Measured facts (consumer census, 2026-09-18):

| Fact | Where |
|---|---|
| One worklist-row click issues 5–6 uncoalesced snapshot publishes plus a reaction cascade (`syncWorkspaceSelection`, `pruneWorkspaces`, timers) that nests further publishes | `apps/web/src/features/worklist/use-unified-work.ts:185-231`, `engine/runtime.ts:872-892`, `:975-985` |
| `runtime.batch()` exists (POD-1645) and is used only by `publishReplica` and the optimism ledger; navigation never uses it | `engine/runtime.ts:913-926`, `engine/actions.ts` (zero `batch` refs) |
| An outbox enqueue publishes twice (size patch, then `recomputeAll`) | `engine/runtime.ts:573-579` |
| `hostMetrics` publishes a fresh snapshot every 5 s; `coarseNow` every 60 s; drafts per keystroke | `runtime.ts:613`, `:567`, `:1178` |
| The worklist slice rebuilds `sidebarSections` + `unifiedWorkList` + `groupUnifiedWorkRows` over the whole issue×session world whenever `store.sessions` identity moves, i.e. on any session delta, and on every clock tick; it has no `isEqual`, so all 7 readers re-render on each rebuild | `viewmodels/slices/worklist/published.ts:164-241` |
| `useSession()` is an O(sessions) `find` inside a selector that runs for every session-bound component on every publish; 33 production `sessions.find(` sites, several per-row or per-`apply` | `apps/web/src/app/store.tsx:140`, `engine/reactions.ts:231,271,391,416`, `slices/worklist/row-attention.ts:233` |
| `useReplicaIssues` (30 readers) wakes on every `issues` array identity change; an optimistic fold makes a new array for a one-row patch, so one press wakes all 30 twice | `apps/web/src/app/store.tsx:171-180`, `worklist/published.ts:176-180` |
| `superagentSlice` has no `sourceEqual`: re-derived on every publish | `viewmodels/slices/superagent.ts:76` |
| Only 2 selectors return fresh objects without an equality guard; the selector layer is otherwise well guarded | `use-agent-fleet-options.ts:50`, `use-handoff-transcript.ts:43` |
| Transcripts, presence and connection health are already OFF the snapshot (own stores), with the reason written down | `ConnectionIndicator.tsx:9-12` |

Reading of the evidence: the cost is the product of **publish volume** (many publishes per
gesture, periodic publishes on an idle client) and **coarse invalidation of the big derived
views** (whole-world worklist rebuild per session delta). Per-subscriber selector work is
second-order. Entity-granular tracking would remove the second factor, but only if the worklist
derivation is restructured into per-entity computeds. A library does not do that by itself.

What is not yet known: which factor dominates on the live instance today, and whether the
HTTP incremental-sync rewrite of 2026-09-15..18 (12 commits under `replica/`) changed the
replica's publish cadence. The July remediation (POD-981/991/999/701) measured warm issue
switches at p50 158 ms; the current "molasses" is unmeasured. Phase A exists to settle that
before the fixes are credited to anything.

## 2. Verdict on the existing plan

Agree with the structure: measure, ship the store fixes that are independently releasable, stop
at a gate, and only then run a bounded reactive pilot on one connected read path
(session change → issue summary → worklist row → UI). Keep the sync kernel, optimism,
outbox, persistence and principal lifecycle untouched. No app-wide rewrite.

Amendments, with reasons:

1. **Phase A shrinks.** The dependency map (P01) is done here. The switch-trace collector
   (POD-701) and the `issueViewModelProjectionStats` counter already exist; what is missing is a
   publish/subscriber/derivation counter. The large-state benchmark exists in CI
   (`apps/web/src/perf/large-state.frontend-perf.tsx`) but drives the retired TanStack replica
   and sits at 674 issues; it must be re-pointed at the kernel facade and given the current
   scenarios. Live cardinality today is 965 issues (312 open), so the fixture scale is not the
   main gap.
2. **Phase B grows.** The census found cheap, certain wins the plan did not list: the outbox
   double publish, the reaction cascade, host metrics on the snapshot, and the worklist
   rebuilding on immaterial session changes. The last one is the single largest suspected
   cost and needs no library.
3. **Navigation coalescing is cheaper than the plan assumed.** `batch()` exists. The open
   question is only whether later setters read state written by earlier ones; if so, make
   `apply()` write state immediately and defer publish+react to the outermost batch.
4. **TanStack DB is a real candidate for the pilot, evaluated on its merits, not on ADR 6.**
   ADR 6 rejected it as a *persistence* layer (localStorage over 5 MB, no multi-key
   transactions). The pilot needs an in-memory reactive read model, which is a different
   question. What the installed package (`@tanstack/db` 0.6.16; current 0.9.2, pre-1.0) offers:
   - Collections keyed by id with btree/reverse indexes, fed through a sync interface
     (`begin/write/commit`) that fits the one-mutation-owner rule: we write effective
     post-optimism rows and never use its own optimistic transactions.
   - Live queries compiled to differential dataflow (`@tanstack/db-ivm`): `join`, `groupBy`,
     `orderBy`/topK, `distinct` are maintained per changed row. That is exactly E2 (sessions
     by issue, children by parent, dependents) and the relational part of E3 (counts by phase,
     latest activity per issue) for free and incrementally. MobX has no such thing: those
     indexes stay hand-written, as they are today in `replica/issue-views.ts`.
   - No DOM dependency; runs on React Native.
   What it does not offer:
   - Reactivity is per *query*, not per property. `useLiveQuery` hands back a new array on every
     change to that query's result. Row-level render isolation means one live query per row or
     component (`findOne`), each its own dataflow graph. Cost at hundreds of rows is
     undocumented, graph runs execute synchronously inside the source commit, and there is no
     public attribution hook (TanStack/db issue #1827, open, filed 2026-09-16).
   - Only `count/sum/avg/min/max` aggregates; `fn.select` cannot be combined with `groupBy`.
     The procedural two-thirds of the worklist derivation (`viewmodels/mission.ts`, 2.5k lines;
     parent/child nesting and session bubbling in `worklist/rows.ts`; time-dependent ranking)
     stays JavaScript over query outputs under either library.
   - Pre-1.0 churn: 0.6.16 to 0.9.2 in this repo's window; an upgrade lands first.
   - Size: 58 KB gzip with the query engine (25 KB collections only), versus MobX 18 KB and
     Legend State 7 KB. Acceptable on both platforms, but not free.
   The two candidates solve different halves. TanStack DB gives incremental relational
   maintenance and needs hand-written render isolation; MobX gives property-granular render
   isolation and an arbitrary computed graph and needs hand-written incremental indexes. The
   decisive questions are empirical and are what D1 measures: per-row isolation cost with N
   per-row live queries versus `observer`, and how much of the real worklist derivation each
   expresses without a second framework.
5. **Library choice stays at the Phase C gate, with a two-candidate proof.** D1 runs the same proof on
   MobX and TanStack DB against A3's data shapes and the criteria above. Legend State v3 is the
   fallback only if MobX fails on build, React Native or React 19 grounds (it changes the read
   idiom app-wide and its v3 is not yet the npm `latest` tag). Valtio tracks reads through a
   snapshot proxy at render time with no first-class computed graph; it does not fit a
   derived-model pipeline and is out. Whichever wins, the pilot uses one framework, not both.
6. **Explicit changed-key routing (C01) stays conditional.** The changed-key set is already
   computed, so the retrofit is small, but every selector that opts in must declare its keys
   correctly or freeze. It is second-order until Phase B evidence says otherwise.

## 3. Epic structure

Parent: POD-4286. Every item is a sub-issue. Phases are shipping order; each Phase B fix
lands on its own. the Phase C gate is an explicit decision issue; Phases D–F are blocked on it.

### Phase A — Evidence (no behaviour change)
- Outcome 1: Live baseline and publish census
- Outcome 2: Store publish and derivation counters
- Outcome 3: Kernel-backed large-state benchmark

### Phase B — Fixes to the current store (each independently releasable)
- B1 Single publish per navigation gesture
- B2 Coalesced outbox and reaction publishes
- B3 Host metrics off the snapshot
- B4 Session-by-id shared index
- B5 Worklist invalidation on material inputs
- B6 Superagent slice input guard
- B7 Whole-store and unguarded selector reads

### Phase C — Gate
- C1 Phase B remeasure and gate decision
- C2 Explicit changed-key routing (conditional, outcome 3)

C1 outcomes:
- Outcome 1: budgets met → stop; keep regression gates.
- Outcome 2: another subsystem dominates → separate measured issue; do not widen this epic.
- Outcome 3: residual is cheap consumers notified unnecessarily → C2 Explicit changed-key routing.
- Outcome 4: shared derived-state invalidation remains material → Phases D–F.

### Phase D — Pilot foundation (disabled by default)
- D1 Reactive library proof (MobX and TanStack DB, same proof; Legend fallback)
- D2 Effective-change contract
- D3 Addressed replica changes through the binding
- D4 Effective changes from the optimistic path
- D5 Principal-scoped presentation model
- D6 Differential and lifecycle contract tests

### Phase E — Migrate the connected path (opt-in)
- E1 Addressed session and draft readers
- E2 Incremental relationship indexes
- E3 Per-issue computed summaries
- E4 Worklist structure, rows and selection split
- E5 Connected-path consumer switch

### Phase F — Validate, release, close
- F1 Pilot A/B acceptance
- F2 Native pilot validation
- F3 Platform rollout with tested rollback
- F4 Pilot scaffolding removal

Conditional, filed only when their trigger is measured: E6 field-level presentation isolation;
E7 incremental hot aggregate.

## 4. Rules for every sub-issue

- One mutation owner: nothing new writes to the replica or queues commands.
- No lost semantics: optimistic edits, rejection/rollback, evict vs delete, readmission, atomic
  rescope, offline hydration, principal isolation, draft-ledger policy.
- Every fix ships with: focused tests, before/after counts from A2/A3, a disable or revert path.
- Timed comparisons run one implementation on the measured path. Differential runs are
  test-only.
- Whole-scope work is allowed at bootstrap/rescope; ordinary deltas must not scan the world.
- Never merge to `dev/mw` or `main` without the operator's go-ahead.

## 5. Acceptance budgets (frozen in A3 before optimisation)

| Measure | Target |
|---|---|
| Idle client | Zero snapshot publishes per minute except the clock tick |
| Unrelated session delta | Zero worklist derivations; zero unrelated session-reader executions |
| Navigation | One snapshot publication per gesture (legitimate optimistic/network publications labelled separately) |
| Warm issue switch, input → next paint | p95 ≤ 100 ms on the nominated targets |
| State/derivation CPU per hot-path event | p95 ≤ 8 ms, with explicit allowances for genuinely broad changes |
| Pilot benefit (only if Phase D+ runs) | ≥ 50 % less p95 state/derivation CPU than the post-Phase-B build |
| Regressions | ≤ 10 % startup / retained-memory increase without explicit approval |

## 6. Source anchors

Store/binding: `packages/client-core/src/store.ts`, `react/provider.tsx`, `react/use-slice.ts`,
`viewmodels/slices/publish.ts`, `apps/web/src/app/store.tsx`.
Runtime: `engine/runtime.ts` (`apply` :872, `batch` :913, `react` cascade, clock :567,
hostMetrics :613, outbox :573), `engine/actions.ts`, `engine/reactions.ts`, `engine/optimism.ts`,
`engine/replica-binding.ts`, `engine/machines-material.ts` (the pattern for a material-field
signature).
Derivation: `replica/issue-view-cache.ts`, `viewmodels/slices/worklist/{published,rows,nav,folds,row-attention}.ts`,
`viewmodels/mission.ts`.
Consumers: `apps/web/src/features/worklist/use-unified-work.ts`, `apps/web/src/app/CommandPalette.tsx`,
`apps/mobile/src/client/hooks.ts`.
Existing tooling: `packages/client-core/src/perf/switch-trace.ts` (`__podiumSwitchTraces`),
`apps/web/src/perf/{large-state.frontend-perf,slice-render-count.test,scoped-session-render.test,tuck-fanout.probe}.tsx`,
`tests/e2e/large-state-bench.ts`, `perf/frontend-large-state.md`.
