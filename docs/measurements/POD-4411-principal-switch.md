# POD-4411 diagnosis: why the pilot principal switch costs 153 seconds

**Verdict: a notify storm. The pilot tail subscribes one listener per
addressed cell (3 per issue = 14,601 listeners at live corpus) where the
legacy tail subscribes once. Each switch fires full-corpus replaces that
dirty every cell, and React's `useSyncExternalStore` re-reads the whole
world once per listener notification — ~19,500 full-world reads per switch,
each touching all 14,601 cells, while only 2–3 renders actually commit.
That is O(listeners × cells) = O(N²) per switch: ~0.5 s at ci, ~127 s at
live. Model construction, first reads, and LRU churn are all second-order;
the renders themselves are negligible.**

## 1. The split that proves it (live: 4,867 issues / 4,304 sessions)

Temporary probe (React ablation over the real provider + hooks, then a
no-React split driving the runtime directly; deleted before landing, method
in §6). Times are per single principal replacement unless noted; every
record carries loadavg+uptime (runs below at 1-min load 2.8–6.6, mostly
3.5–5.4, under `bench:ludovico`):

| Switch topology (live) | Pilot | Legacy |
|---|---|---|
| React, **with** full-list tail (F1's tree) | **126–131 s** (n=3 runs: 131.4, 126.0, 127.2; F1's own median 153 s at load 6.7) | 0.15–0.18 s |
| React, **without** the tail | 2.3–2.5 s | 0.14–0.17 s |
| No-React (construct+start+reads+subscribe) | ~1.1–1.5 s | ~0.05 s |

Removing the tail removes 124 s of the 127 s. The tail is not one reader
among many — it is 98% of the switch. Legacy pays nothing for the same
tail (0.15 vs 0.17 s): it holds ONE root subscription and memoizes the
derivation, while the pilot holds 14,601 cell subscriptions.

Inside the 127 s switch, temporary env-gated counters (also deleted)
count, per switch:

| Counter | Live value |
|---|---|
| model cell `getSnapshot` calls | **189,540,480** |
| computed-graph cell `getSnapshot` calls | **95,073,093** |
| model listener invocations (`modelNotify`) | **19,480** |
| graph listener invocations (`graphNotify`) | **0** |
| replace applies (`applyReplace`) and their wall time | 3, taking **126.0 s of 127.2 s** |
| worklist recomputes (`worklistReads`) and their wall time | 5, taking 0.67 s |
| graph re-derivations (`graphEval`, dirty) | 382k (negligible beside 285M reads) |
| committed leaf renders (FullList / Worklist bodies) | 2 / 3 |

The arithmetic closes: 19,480 notifications × ~14,600 cell reads per
check ≈ 284M reads ≈ the 285M counted, at ~440 ns per read ≈ 126 s.
Re-derivation is 0.1% of calls; renders are 5 commits. **The switch is
285 million cache-hit cell reads, not work.**

## 2. The mechanism, step by step

1. `useReplicaIssues` (the tail) subscribes 3 listeners per issue — wire
   row, projection row, summary — totalling 14,601 live listeners at live
   N, all funnelled into one component (`apps/web/src/app/store.tsx:372`).
   Legacy's equivalent subscribes once to the root store.
2. A principal switch tears the runtime down and builds a successor, which
   publishes **three full-corpus replaces**: the constructor seed, the
   `replicaBinding.start` bootstrap, and the async hydrate (36
   effective-view index builds logged per switch: 3 rounds × 12 kinds).
   Each replace dirties every one of the ~15k staged rows
   (`presentation/model.ts` `apply`, `replacement` branch).
3. The seed replace notifies ~nobody (the tail has not subscribed yet).
   Bootstrap + hydrate notify ~9,700 model listeners each = the 19,480
   counted. (Graph listeners fire zero times: eager re-evaluation
   reproduces `sameValue`-equal summaries, so versions never move — the
   graph half of the storm is pure re-reads, never notifications.)
4. `useSyncExternalStore` calls the component's `getSnapshot` on **every**
   notification as its eager bail-out check — not once per render. Each
   check re-reads all 14,601 cells plus the 4,867×3 identity loop (~6.5 ms
   clean), hits the memo, and discards the result. 19,480 × 6.5 ms ≈ 127 s.

Without publications there is no storm: mounting the tail on an already
settled runtime costs 0.6 s live (pure subscribe+read), and firing the
start replaces into 14,601 *noop* listeners costs 0.7 s. React's
per-notification checks are the ~126 s difference.

## 3. What the 153 seconds is NOT

- **Not model construction.** Constructor + start (incl. all 36 index
  builds and the relationship-index rebuild over ~15k rows) is 0.3–0.8 s
  live, 0.05–0.14 s at ci. Real, 10–100× legacy's ~7 ms, but 0.5% of the
  switch.
- **Not first reads.** First worklist 0.34–0.60 s live (~5× the legacy
  slice's 0.04–0.16 s — POD-4410's unguarded-`readWorklist` finding,
  unchanged); first summary pass 0.28–0.45 s; subscribe-all 0.22–0.30 s.
  Second worklist read is 0.01 ms. All second-order.
- **Not LRU-128 churn as the driver.** The churn is real — an immediate
  second summary pass costs as much as the first (live 275–281 ms vs
  279–342 ms; ci second pass 131 ms vs 54 ms first, reproducing POD-4410) —
  but pinned (subscribed) re-reads are 19–24 ms for all 4,867 summaries,
  and the storm's 285M reads are overwhelmingly clean hits, not
  re-derivations (382k). Raising the limit would shrink the ~0.5 s
  first-pass terms, not the 126 s storm.
- **Not renders.** 2–3 leaf-body executions per switch. The DOM is
  signatures; commit cost is unmeasurable beside the checks.

## 4. Why legacy is fast (and one honest caveat)

Two independent reasons, both measured:

1. **One subscription, not 14,601.** A legacy replace notifies a handful
   of root listeners; each component checks once against memoized
   derivations (`issueModelsBySnapshot`, the slice publisher). The
   per-notification check count is O(components), not O(cells).
2. **Same-replica cache reuse flatters F1's 0.2 s by ~2×, no more.** The
   harness reuses one replica object across generations, and the legacy
   issue-view cache is keyed by Replica identity: same-replica switch
   shows `modelBuildsDelta 0`, tail re-read 0.04 ms. Over a FRESH replica
   (production topology — the provider builds over
   `createReplicaFn(nextPrincipal)`), legacy pays the full world build:
   first slice 68 ms live incl. all 4,867 row builds. So production legacy
   is ~0.1–0.3 s, not 0.05 s — a correction in the second significant
   figure. The 750× stands.

## 5. Scaling: why 35× at ci is 750× at live

Cost per switch ≈ notifications × cells ≈ O(N²): ci (2,022 cells,
2,708 notifies) 0.51–0.62 s vs live (14,601 cells, 19,480 notifies)
126–131 s — 217× for 7.2× corpus. Pure O(N²) predicts 52×; the remainder
is per-read cost growth (ci ~10M reads/s vs live ~2.3M reads/s, likely
working-set/cache effects across the ~50k-node graph — inference, marked
as such; it moves the exponent, not the verdict or the remedy).

## 6. Cold-start terms for the platform rollout

First paint under the pilot, live, no-React then React mount:

| | Pilot, no tail | Pilot, with tail | Legacy |
|---|---|---|---|
| construct + start (36 index builds incl.) | 0.3–0.8 s | same | ~0.01 s |
| first worklist / slice | 0.51–0.60 s | same | 0.10–0.16 s |
| React mount | **2.3–2.6 s** | **122–126 s** | 0.19–0.28 s |

A pilot cold start that mounts the whole-world tail costs two minutes
before any interaction. Without the tail it costs ~2.5 s — still ~10×
legacy, and the storm fix below only recovers the tail term.

## 7. Candidate remedies (diagnosis only — no code changed)

Nothing here is small *and* obviously correct, so per the brief nothing
is applied. Ordered by leverage:

1. **Coalesce tail subscriptions (kills the O(N²), keeps ~2 s).**
   Subscribe once per component — e.g. a generation/epoch cell bumped
   whenever any tail input changes — instead of 3 listeners per issue.
   Expected effect: 19,480 checks → ~2 per replace; switch ≈ today's
   no-tail 2.3 s. Rough cost: days (new invalidation token in the model,
   hook change, plus the correctness proof that no update is missed).
   Medium risk: a missed bump silently stales the world.
2. **Fewer full-corpus replaces per switch (~3× off the remainder).**
   Seed + bootstrap + hydrate each dirty all cells; collapsing or
   no-op-ing redundant rounds divides whatever the per-replace cost is.
   Small–medium, correctness-sensitive (each round carries real state).
3. **Guards on pilot reads (POD-4410's remedy; insufficient alone).**
   `sourceEqual`/`isEqual` on the worklist/full-list reads would skip
   re-derivation but NOT the per-notification checks — the 14,601 cell
   reads and the identity loop run before any guard can hit. Say this
   loudly when pricing: guards fix the 0.7 s, not the 126 s.
4. **Real fix (operator decision, large).** Addressed invalidation
   end-to-end so a replace does not dirty all N cells, and/or stop
   enumerating the world through 14,601 live cells (virtualize/paginate
   whole-world reads). Weeks; presentation-model redesign, out of this
   issue's authority.

Note the ceiling: even remedy 1 lands the switch at ~2.3 s, an order of
magnitude above legacy and above any warm-switch budget. The remainder —
unguarded full-corpus first reads (POD-4410), 36 index builds per switch,
replace rounds — is the next round of work, not this one.

## 8. Residuals and limits (stated, not smoothed)

- Cells are n=1–2 per topology live (effect sizes 100×+; counts are
  structural and load-independent per F1's own principle). The headline
  reproduces across three independent runs (131.4, 126.0, 127.2 s) plus
  F1's 153 s median at higher load.
- Constructor/start wall varies run to run at similar load (live pilot
  construct 89→352 ms, start 204→427 ms). Second-order; not investigated.
- The 4–6× per-read slowdown ci→live is inferred as working-set/cache
  effects, not proven; it does not affect the mechanism or the remedies.
- A killed perf run poisons later renders in the same file (abandoned
  async `act` — F1's hazard, re-observed once here); all numbers above
  come from runs that completed, timeouts were 600 s live, and no sample
  from a timed-out run is cited.

## 9. Rerun vehicle and hygiene

Rerun is the F1 harness (`apps/web/src/perf/
pilot-ab-acceptance.frontend-perf.tsx`,
`bun run --cwd apps/web test:perf:large-state -- pilot-ab-acceptance`).
The split probe used here (`pilot-principal-split`, plus temporary
env-gated counters in `presentation/computed.ts` and `presentation/
model.ts` reading a `globalThis` holder — no imports, no exports) is
deleted; the evidence above is in this document. All timing ran under
`podium lock acquire bench:ludovico --ttl 30m --wait` (released between
runs); every record carries `loadavg`+`uptime`. Final tree is docs-only:
no product code was changed.
