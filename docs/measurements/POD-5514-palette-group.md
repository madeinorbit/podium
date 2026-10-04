# Palette and populated group latency

## Group result

Populated-group expansion is **82.0 ms median**, below POD-5501's historical
OLD **101 ms** and a fresh OLD capture's **116.1 ms**. Palette work remains
in progress; this is the first, group-only landing.

The causal matrix uses the same minified production source based on pilot
`96f705cd4e`, the POD-5501 corpus (seed 4443, 4,867 issues / 4,304 sessions),
and the same 117-row project group. Corpus SHA-256:
`2458ea73e0e6182b8f67ae7b0aa618e882fcb60bc9dd9eaf5778e42e1261363e`.

| Group policy | Source | n | Input → Paint p50 / p95 | Thread CPU p50 | Input → DOM p50 | Layout CPU p50 |
|---|---|---:|---:|---:|---:|---:|
| Discard DOM | `e47e4067c2` | 8 | 189.6 / 208.3 ms | 183.4 ms | 138.5 ms | 26.5 ms |
| Retain DOM, release projections | `8f279f6649` | 8 | 136.3 / 157.1 ms | 131.6 ms | 90.3 ms | 25.3 ms |
| Retain DOM and lazy projections | `84abd07618` | 16 | **82.0 / 122.1 ms** | **75.3 ms** | **38.1 ms** | 24.1 ms |

Discarding the visited rows repeats React mounts. Retaining only DOM still
recreates the rich row/worktree projections and their MobX computed graph.
Both costs are isolated by the two OFF controls. Layout remains about 24–27 ms;
the gain comes primarily before the DOM witness, rather than cheaper layout.
The lazy projection pauses before MobX's computed-staleness check, so a hidden
update marks it dirty without evaluating the hidden row graph.

Visited project groups keep their physical rows after the closing animation.
Closed panels are hidden, inert and aria-hidden; clocks and row subscriptions
pause. Reveal catches up once, preserving the physical row nodes. Owner and
pool teardown release retained observers. Other folds retain their prior
unmount behavior. The landing scopes the new explicit owner cleanup to retained
projections, preserving ordinary projections' existing lifetime.

## Verification and limits

All 35 focused tests in four files passed foreground on flatblock in
`~/podium-test-5514`, with its copied `.toolchain` and checkout-local install:
sidebar runtime 15, palette runtime 1, runtime projections 10, host projections 9.
The group guard checks exact DOM identity, hidden issue/session/clock changes
causing zero rich reads or leaf commits, fresh reveal, and zero rich work on
an unchanged reveal. The projection guards check computed suspension and owner
teardown. This is focused evidence, not a lean gate or a full-suite result.

The additional legacy flat-row file fails before its assertions because its
pool mock has no `sidebar`; the same failure occurs on untouched pilot
`96f705cd4e`. POD-5549 tracks that separate fixture repair.

Live A1 controls on ludovico also completed using an isolated production
preview against the operator backend; every layout write was held inside that
browser and never forwarded. Discard-DOM expansion was 288.3 ms median /
282.6 ms thread CPU; DOM-only was 365.9 ms / 231.6 ms. These changing loaded-host
observations do not establish a live wall-time improvement. Final lazy A1 and
palette causal captures are pending.

Trusted input timestamps, a semantic DOM witness and actual Chromium Paint
bound each interval. CPU uses Chrome thread timestamps. Two extra profiled
samples per action are excluded from quantiles; every unprofiled sample is
included. Percentiles use sorted element `min(n-1, floor(q*n))`; n=8 and n=16
are descriptive, with no confidence interval. Captures alone hold
`bench:flatblock`, released when they finish; only recorded PIDs are stopped.

Raw traces, collectors, control bundles and profiles remain in this issue's
ignored `.artifacts/pod-5514` and its owned flatblock checkout. Live raw evidence
stays local. The final report will include safe numeric aggregates and exact
landing provenance. Landing targets only `integrate/4286-pilot`, ff-only under
its merge lock; no remote publication, `dev/mw` or `main` mutation is included.
