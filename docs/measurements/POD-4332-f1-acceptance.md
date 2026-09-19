# F1 pilot A/B acceptance — report (POD-4332)

**Verdict: FAIL — do not roll out. File targeted follow-ups, no expansion.**
The pilot avoids exactly the downstream work it was built to avoid (worklist
derivations, whole-world row builds, root selector runs, subscriber wakes go to
the floor on every scenario, deterministically, at both scales). But at the
live corpus the pilot-only publish path costs ~130–330 ms per material
publication against ~30–70 ms for the whole legacy publish+derive, and a pilot
principal replacement costs ~153 s against ~0.2 s legacy. The ≥50%-benefit
budget and the 8 ms state/derivation budget fail on wall time at live scale.
A failure reported accurately is a successful acceptance run: the counts prove
the mechanism, the wall proves the price, and the three follow-ups below are
narrow enough to price separately.

## 1. What was actually compared

Same binary, one URL parameter apart: `presentationModel` on (pilot) vs off
(post-Phase-B legacy) on the identical build, fixture seed and event order —
the A/B switch the coordinator prescribed (`hasPresentationPilot`,
`apps/web/src/app/store.tsx`). This is NOT the C1-preserved-SHA build
(`c728e9c25`); it is better isolated than that (no intervening-commit
confound, no second binary, same hardware, interleaved arms) and worse in one
respect, stated here: any Phase-B-adjacent change landed after C1 is inside
both arms equally, so the delta is purely the pilot. Differential shadow work
was off for all timing (the D6 driver lives only in `runtime.test.ts` and is
never imported by the harness).

## 2. Provenance and method

- Measured checkout: `e7f3cc997` on branch `issue/4332-f1-pilot-a-b-acceptance`
  (off `integrate/4286-frontend-perf`), 2026-09-19/20 UTC. Harness:
  `apps/web/src/perf/pilot-ab-acceptance.frontend-perf.tsx` (new, in the
  `test:perf:frontend` lane) plus the `pilot-ab-acceptance` include line in
  `apps/web/vitest.frontend-perf.config.ts`. Numbers: companion
  [POD-4332-f1-ab.json](POD-4332-f1-ab.json), 24 `[f1-ab]` records.
- Host: ludovico (8 vCPU, shared). POD-4403 benchmarked concurrently for part
  of the run; per the coordinator's hygiene instruction all late timing ran
  under `bench:ludovico` and every record carries `runner.loadavg` (observed
  4.0–14.8). Arms interleave per sample (even iterations pilot-first); the
  clock-tick scenario shares one advance and reports the joint wall unsplit.
- Corpus: A3 kernel fixture at `live` (4,867 issues / 4,304 sessions, the A1
  corpus order) and `ci` (674/530). Live n=5/arm (tick/principal/burst n=3–5
  as labelled); ci n=10/arm (burst/activation n=5). Percentiles are
  descriptive, not confidence intervals; at n=5, p95 is the max and is labelled
  as such in the tables below.
- Mounted tree (identical JSX both arms): 2 addressed session leaves (E1), 1
  draft leaf (E1), 2 singleton issue refs (E5), ids enumeration (E6), the tail
  full-list read (E6/E7, **ci scale only** — its legacy whole-world read costs
  minutes per call at 4,867 issues, beyond this lane's budget; tail isolation
  is proven by counts in the E7 harness and here at ci), the production
  worklist read (E4/E7), 2 pressable rows. The pressables are intentionally
  UNMIGRATED legacy readers: 2 hooks × 2 selectors = a floor of 4–8 root
  selector runs per publication in the pilot arm, documented, not hidden.
- Scenarios: all eight A3 kernel scenarios in A3 event order, plus
  inactive-worklist activation (churn against the unmounted view, then
  rerender-activation on the same runtime — no teardown), 50-event burst
  recovery (completeness proved by per-row snapshot check, because the burst
  saturates the 256-slot publishes ring: counter drops allowed there and
  reported), and three repeated principal replacements (teardown+rebuild timed;
  same warm replica, so hydration is excluded and isolation stays D6's).
- Layer split per hot-path event: `storeMs` (kernel ingest through runtime
  apply, adapter bookkeeping and eager legacy derives, inside act before
  flush), `computedMs` (forced pilot worklist-cell recompute so lazy pilot
  derivation cannot hide inside the render phase), `reactMs` (flush window).
  Act-exit render/commit and settle fall in `total` outside the three splits.
  Layout has no happy-dom timer (C1's live CDP buckets are the reference,
  non-comparative); GC has no per-event timer (endpoints only, no verdict —
  same as C1); heap ≤10% is therefore UNESTABLISHED here, same as C1.
- Control dimension: pilot vs legacy visible values asserted identical after
  cold mount and after every sample (`textsEqual`, full-structure hashes, not
  just counts). Every record has it `true`. No event was dropped or delayed
  to improve figures: the only allowed counter drops are the burst ring
  saturation above, with functional completeness proved in-test.

## 3. Avoided work — the counts (strong, load-independent evidence)

Live corpus, per hot-path event (p50; max identical unless noted):

| Scenario | Publishes P/L | Wakes P/L | Selectors P/L | Row builds P/L | Worklist derives P/L | Commits P/L |
|---|---|---|---|---|---|---|
| unrelated session | 1 / 1 | 5 / 11 | 4 / 10 | 0 / 1 | **0 / 1** | 1 / 1 |
| draft edit | 1 / 1 | 5 / 11 | 4 / 11 | 0 / 0 | 0 / 0 | 1 / 1 |
| host metrics | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| clock tick | 1 / 1 | 5 / 13 | 4 / 12 | 0 / 0 | **0 / 1** | 1 / 1 |
| issue click | 1 / 1 | 5 / 11 | 8 / 14 | 0 / 0 | **0 / 1** | 1 / 1 |
| optimistic echo (6 pubs) | 6 / 6 | 30 / 66 | 24 / 60 | 0 / 1 | **0 / 1** | 2 / 6 |
| optimistic rejection (6) | 6 / 6 | 30 / 78 | 24 / 72 | 0 / 0 | **0 / 2** | 2 / 5 |
| mixed feed (2) | 2 / 2 | 10 / 22 | 8 / 21 | 0 / 1 | **0 / 1** | 1 / 1 |
| burst ×50 | **50 / 18** | 250 / 208 | 200 / 189 | 0 / 19 | **0 / 19** | 1 / 1 |
| activation (5 churn) | 5 / 5 | 25 / 60 | 24 / 67 | 0 / 5 | **0 / 1** | 2 / 2 |
| principal ×3 | 9 / 9 | 45 / 117 | 40 / 120 | 0 / 0 | **0 / 2** | 3 / 3 |

Unrelated singleton leaves stay at zero executions in the pilot arm on every
scenario (session:s0, ref:i0, ids all p50/p95/max 0). The E7 zero-derivation
claim replicates at live corpus: the pilot arm derives the published worklist
**zero** times on all eleven scenarios while the legacy arm derives on all
material ones. CI scale shows the same pattern (e.g. echo wakes 30/78,
selectors 24/72, derives 0/1, full-list leaf executions 0/6).

Two counts run the WRONG way and are findings, not noise:

- **Burst publishes 50 pilot vs 18 legacy for the identical 50 kernel events.**
  The legacy binding/facade coalesces the synchronous burst; the pilot
  effective-changes path publishes per event. Deterministic at both scales
  (ci: 50/18 as well). Follow-up 3 below.
- **Pilot selector runs sit at the unmigrated floor (4–8), never zero**,
  because the two pressable rows are legacy readers. Any production surface
  left on root selectors keeps this floor; the 33 migrated sites do not.

## 4. Wall time — load-qualified supporting evidence

Live p50 / [p95], ms, with the 1-minute loadavg from the record:

| Scenario (load) | Pilot total | Legacy total | Pilot store-phase | Legacy store-phase |
|---|---|---|---|---|
| unrelated (11.5) | 457 / [572] | 144 / [147] | 452 / [568] | 130 / [146] |
| draft (13.8) | 1.0 / [2.3] | 6.8 / [7.6] | 0.8 / [1.8] | 6.6 / [7.4] |
| host metrics (12.4) | 0.1 / [2.1] | 0.1 / [0.3] | 0.0 / [0.2] | 0.0 / [0.1] |
| clock tick (6.1, joint) | — | — | joint advance 137–245 (7 advances) | same wall |
| issue click (7.4) | 413 / [462] | 72 / [83] | 397 / [462] | 67 / [83] |
| optimistic echo (7.9) | 825 / [969] | 177 / [223] | 808 / [949] | 146 / [198] |
| optimistic rejection (10.8) | 164 / [213] | 161 / [225] | 87 / [122] | 78 / [120] |
| mixed feed (9.9) | 467 / [487] | 111 / [156] | 460 / [486] | 104 / [146] |
| burst ×50 (4.8) | 21,748 / [23,251] | 5,021 / [5,294] | 21,735 | 5,018 |
| activation (4.0) | 312 / [394] | 354 / [360] | 161 | 237 |
| principal ×3 (6.7) | **153,147** / [153,583] | 203 / [254] | — (rebuild) | — |

CI scale for contrast (same scenarios): click 10.8 vs 5.9; echo 28.9 vs 16.8;
burst 400 vs 379 (tied); activation 36 vs 23; principal 533 vs 15. At 674
issues the pilot is within ~2× on wall; at 4,867 it is 4–8× on material
scenarios and ~750× on principal replacement. The pilot-only publish path
(effective-changes + presentation apply) costs roughly 3–7 ms per material
publish at ci scale and roughly 130–330 ms at live scale — superlinear in the
corpus, and the dominant term in every pilot sample. `computedMs` (forced
pilot worklist recompute) is ~0.01 ms on material scenarios — the worklist
recompute is NOT the cost; the publish path is. Two puzzles are reported
unsolved rather than smoothed over: rejection ties (164 vs 161) while echo
diverges 5×, and the navigation delta (332 ms for a local-keys-only publish)
is larger than the per-publish rate elsewhere. Follow-up 1 owns both.

Warm-switch input→paint was not measured (happy-dom has no paint; stated, not
claimed). Live mounts swing 5 s (load ~5) to 102 s (load ~15); mount variance
is reported separately in §6, not folded into any verdict.

## 5. Frozen-budget verdicts (design doc §5)

| Budget | Verdict |
|---|---|
| Idle: zero snapshot publishes/min except the clock tick | **Pass** — hostMetrics 0/0/0 publishes/wakes/derives both arms both scales; tick 1 publish labelled clock. |
| Unrelated session delta: zero worklist derives, zero unrelated reader executions | **Pass (pilot)** — 0 derives, 0 singleton-leaf executions, at both scales. Legacy control derives (1), so the counter is proven to fail when the fix is absent. |
| Navigation: one publication per gesture | **Pass (both)** — 1 publish both arms both scales; optimism/background labelled separately (echo 6/6). |
| Warm switch p95 ≤ 100 ms input→next paint | **Not demonstrated** — no paint in this harness. Nothing passes or fails here. |
| State/derivation CPU p95 ≤ 8 ms per hot-path event | **Fail** — pilot store-phase p95 122–949 ms on material live scenarios (legacy 83–198 ms also fails; the pilot fails by more). Draft (1.8 ms pilot) and host-metrics (0.2 ms) pass. |
| Pilot benefit ≥ 50% less p95 state/derivation CPU than post-Phase-B | **Fail** — pilot wall is 4–8× legacy on material scenarios at live scale, tied-to-slightly-better only on activation (312 vs 354, n=3), better only on draft/host-metrics. Counts improve ≥50% nearly everywhere; CPU does not. |
| Regressions ≤ 10% startup/retained memory | **Unestablished** — no paired heap endpoints in this harness (same verdict as C1, same reason). The principal-switch wall (153 s vs 0.2 s) is the startup-adjacent datum instead. |

Per C1's warning, no savings are added across rows anywhere in this report.

## 6. Unrelated bottlenecks, named separately

- **Box contention dominates absolute wall.** Mounts swing 5–102 s with load;
  all late timing ran under `bench:ludovico` with load recorded per record.
  Counts ( §3) do not move with load and carry the verdicts they can carry.
- **Live mounts are heavy in both arms** (replica seed + first reads over
  4,867/4,304 rows); only the pilot's ~150 s switch premium (§4) is
  pilot-attributable.
- **A killed test poisons the file** (abandoned async act leaves later renders
  empty): two live tests were lost to 180 s timeouts before timeouts were
  raised, and their reruns are the numbers above. No result below comes from a
  run that timed out.
- **`repoUsageAt` is not credited to the pilot** (POD-4340 fixed it
  separately); the MRU hotspot does not appear in these windows, consistent
  with B8.
- **Computed-graph LRU(128) < live N**: the first full-list read evicts its
  own idle roots and React logs one mount-time getSnapshot-caching warning
  (ci and live; converges after subscribe; values verified identical). Worth
  a look inside follow-up 2, not a verdict.

## 7. POD-4394 ordering check: CONFIRMED different

Requested explicitly by the coordinator. Sessions attached to one issue in
non-lexicographic insertion order: pilot
`memberSessionIds = ["s0","s9002","s9000","s9001"]` (insertion rank) vs legacy
`["s0","s9000","s9001","s9002"]` (lexicographic). Set-equal, order differs —
cosmetic, user-visible wherever member order renders, and live-shaped. F3
needs the differential the E6 work already recommended before rollout.

## 8. Follow-ups (filed, not expanded)

1. **Pilot publish-path overhead at live corpus** (C2/C3 candidate): isolate
   effective-changes computation vs `presentation.apply` per material publish
   (~130–330 ms at 4,867 issues vs ~3–7 ms at 674); explain the rejection tie
   and the navigation magnitude; subsume the burst 50-vs-18 coalescing gap.
2. **Pilot seed / first-read / principal-switch cost at live corpus**
   (~153 s vs ~0.2 s; ci 533 ms vs 15 ms): profile model build vs first
   worklist/summary computation, include the LRU(128) eviction churn; sets the
   cold-start terms for F3.
3. (No third code issue: member-order goes to F3 as rollout input via the
   coordinator mail, and the harness stays as the rerun vehicle after 1–2
   land — no circular dependency, it asserts against either outcome.)

## 9. Revert / disable path

The pilot remains behind `?presentation-model=1`; flag off is the untouched
legacy application. This issue changes no product code: one perf file plus one
config include line. Rerun is
`bun run --cwd apps/web test:perf:large-state -- pilot-ab-acceptance`
(ci ~1 min, live ~15–25 min under the bench lease).
