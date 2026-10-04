# POD-5513 cold startup

The narrow production fix improved live A1 cold startup from **6,120.3 to
5,871.9 ms** (n=8 per arm), with main-thread CPU down **7.7%**. The original
**≤2,500 ms and ≤matched OLD** corpus budget is **not certified**. POD-4286's
coordinator requested landing the narrow fix without another corpus or live
capture and assigned remaining whole-list startup work to POD-5530.

The production change bounds synchronous IndexedDB
write submission to 256 requests, continuing from the last request's success event
inside the same transaction. It also stops building cold identity answers that a
replacement publication immediately discards. Allocation prototypes were dropped
from the production diff after their measured live regression.

## Evidence and method

POD-5501 reported OLD `5e3ece5cd6` versus NEW `1aa0ec71f6`, matched web 1×,
provisional n=8, approximately 2.5 s versus 3.3 s. The first repeat here used pilot
`c624fdca39` after old-store deletion `e22a8b6bd9`: NEW 3,836 ms versus OLD 3,088 ms,
eight fresh contexts each. These separate cohorts establish that deletion did not
remove the regression; they do not certify a matched budget.

The accepted production A1 comparison uses pilot `44fe1e8acc` and narrow
candidate `4e6b8b6a51`. The landing was rebased onto pilot `d13769664f`; candidate
`d4993be9c6` passed focused checks and built as `bundle+BdGnn_hw`, web task
`88e2b8fb0cf5bb88`. It preserves the incoming nonresident session-fact updates.
That rebased runtime has not been timed. Every measured runtime was built on
flatblock in an issue-owned `~/podium-test-5513-*` checkout, with a copied
`.toolchain`, Bun 1.4.2 and `bun run setup:worktree` before building or checking.
Builds and checks finish before requesting `bench:flatblock`. Captures run in the
foreground; the lease is released when capture finishes, before cleanup/reporting.

The corpus is POD-5501's unchanged web 1× corpus, semantic SHA-256
`2458ea73e0e6182b8f67ae7b0aa618e882fcb60bc9dd9eaf5778e42e1261363e`.
Cold samples each use a fresh Chromium 153 context, viewport 1800×1000,
reduced motion, blocked service workers and HTTP cache disabled by fixture
request routing. Neutral same-origin preparation loads no application assets.
Timing ends at actual Chromium Paint after a visible, unobscured sidebar issue
row, with the boot splash absent. Main-thread CPU uses Chrome thread timestamps.
Every cold context must commit the complete corpus before its warm reload.
Profiles are separate final samples and never enter the startup median.

Live measurements use A1 from [POD-4286's baseline](POD-4286-baseline.md): private
production previews over the existing operator backend `127.0.0.1:18787` on
ludovico, viewport 1600×1000, Chromium 148.0.7778.96, fresh context per sample,
identity HTTP transport and blocked service workers. Operator cookies, raw traces
and profiles remain on ludovico. The live server upgraded to
`0.1.1-dev.270+44fe1e8` during an earlier cohort; its connection-refused/502 interval
invalidates that cohort. The final repeat starts after recovery. OLD cannot boot
against this live server's wire-version floor of 4, so live A1 compares current
pilot with the fix, while the unchanged corpus supplies the OLD comparison.

## What the new startup adds

| Suspect | Counterfactual and observation | Implication |
| --- | --- | --- |
| Native persistence submission | OLD stores 17,655 entity records; NEW stores 21,972, including normalized personal state. In the live control, one task queued 21,868 writes in 1,079 ms before paint. Batching submits at most 256 synchronously and lets paint happen while the same transaction continues. | Confirmed blocking cost. No payloads or durable rows are omitted. |
| Pool construction | Measured constructor/setup is 5–10 ms. Suppressing issue/session replacement admission keeps full durable data but does not consistently improve first paint. | Pool setup does not explain the regression by itself. |
| Cold indexes | Full replacement costs about 0.38–0.62 s in the live diagnostic; the issue-reader component costs about 0.09–0.14 s. Its off switch retains storage rows but intentionally loses history-query coverage. | Real work, but disabling required indexes is not a shippable fix. These inclusive timers overlap other work. |
| Screen attach | Keeping only sidebar, pane and shell still reaches the row. Removing pane/shell attach prevents it. The smaller attach set gives small or inconsistent gains across cohorts. | Preserve required preparation and inactive command-palette observation. Async attach duration is not an additive startup cost. |
| Bundle | Initial corpus repeat: OLD 101 startup JS files / 2,065,778 decoded bytes / 668,192 gzip bytes; NEW 148 / 2,930,160 / 922,789. Preloading the live control's 159 startup modules with empty IndexedDB removes background parse and about 3.2 MB of transfer. | Added bundle work is measurable; the preload counterfactual does not restore startup by itself. |
| Allocation prototype | A production allocation-only A1 pair regressed from 7,442 to 8,390 ms (n=8 each). Adding the prototype to batching also gave no live wall-time advantage in the smaller diagnostic cohort. | Drop the prototype from the production diff. |

The native commit implementation was the same in OLD and the initial NEW;
the new data layout and larger bootstrap increase its work. The fix changes how
that work shares the browser task queue. It preserves the transaction boundary,
cursor/outbox ordering, and eager versus durable publication rules.

The diagnostic's first live bulk commit took 19.59 s in the control and 21.86 s
with batching. This is background persistence duration, not navigation-to-paint.
Settled phase metrics and complete durable counts retain that cost; batching does
not claim to eliminate it.

## Causal switch results

One error-free A1 cohort on pilot runtime `0a896bf2b1`, three unprofiled samples
per arm, balanced rotating order, gave:

| Arm | Navigation → Paint median | Main-thread CPU median |
| --- | ---: | ---: |
| Control | 6,959 ms | 4,629 ms |
| Native request batching | 5,706 ms | 4,095 ms |
| Batching + replacement-query pruning | 6,012 ms | 4,621 ms |
| Batching + all allocation changes | 6,256 ms | 4,024 ms |

A second error-free cohort, two unprofiled samples per arm, exercised the
remaining switches. Control was 10,373/5,040 ms wall/CPU; preloaded bundle
9,954/4,907; issue-reader index off 8,866/4,942; minimal attach 10,439/4,901;
resident replacement off 9,153/4,942. This small, noisy cohort establishes the
switched work, not independent additive savings. Preloading created zero
IndexedDB databases before navigation; these warmed-code samples cannot qualify
as production cold-start evidence.

## Accepted production comparison and guard

The accepted A1 production comparison is complete and error-free: eight unprofiled
samples per arm, alternating order, backend `44fe1e8` unchanged before/after,
6,294 issues and 5,244 sessions durably hydrated in every context.

| Production arm | Navigation → Paint median | Main-thread CPU median |
| --- | ---: | ---: |
| Pilot `44fe1e8acc` | 6,120.3 ms | 4,312.4 ms |
| Narrow fix `4e6b8b6a51` | 5,871.9 ms | 3,979.0 ms |

Wall median improves 4.1%; CPU median improves 7.7%. These are descriptive loaded
live-host results. Pilot subsequently advanced to `d13769664f`, including reader
and cold-index changes. These measurements remain evidence for the previous
runtime. Per the coordinator's 2026-10-04 23:05 and 23:13 UTC issue mail, no new
production comparison or matched corpus capture was run. An unstarted queued
corpus capture was canceled, and its recorded processes were cleaned up.

The original OLD comparison is therefore incomplete: the first separate cohorts
were OLD 3,088 ms / NEW 3,836 ms. A later paired cohort overlapped an issue-owned
build and is explicitly excluded. Live captures interrupted by the operator
backend upgrade are also excluded. None certifies the original 2.5 s target.

The budget guard requires at least eight unprofiled production cold samples per
arm from the same leased alternating cohort, corpus, browser, cache policy and
collector. It rejects diagnostic builds, missing durable hydration in any cold
context, wrong paint boundaries, application errors, mismatched build stamps and
explicitly excluded evidence. Its budget is the lower of the matched OLD median
and 2,500 ms.

```sh
python3 apps/web/harness/cold-start-pair.py --candidate=candidate4 \
  --baseline=current --samples=8 --round=6
python3 apps/web/harness/cold-start-guard.py \
  --old OLD/run.json --candidate CANDIDATE/run.json --out guard.json
```

Populate the private checkouts with POD-5501's unchanged `corpus-1x.json` and
`rows-1x.json`, and copy the exact same `cold-start.mjs` collector to every arm.
The pair controller prepares isolated fixtures before queuing for the timing
lease and records its own PIDs. It renews only during capture and cancels an
unfinished queue request during cleanup.

This is the recipe for a future matched budget capture; it was not run for the
landing. Guard behavior is tested, but there is no accepted production budget
pass. [The numeric summary](POD-5513-cold-start-summary.json) includes the accepted
samples and explicit evidence limits.

Focused validation on flatblock before the rebase: 73 storage, reader and budget-guard tests green;
three actual Chromium IndexedDB completion/reload/close checks green. Reload and
close preserved the complete PRE state, while completion persisted all 4,096
records, the POST cursor and the outbox deletion. The default browser lookup
failed before execution; rerunning only the native file with the installed
capture browser passed. Filtered graph/sync typecheck: nine tasks green. After
rebasing onto `d13769664f`, 46 tests in `reader-queries.test.ts`,
`reader-question-bounds.test.ts` and `cold-start-guard.test.ts` passed; filtered
graph typecheck passed nine tasks, and the canonical production web build passed.
This is focused evidence, not a full-suite or lean-gate claim.

## Remaining startup work

POD-5530 owns remaining whole-list startup work. The observed paths include
row-source session fact rebuilding and facade/index preparation, cold reader
index construction, and React preparation for attached screens. The initial
live profile attributed roughly 1.76 s to session-fact flushing, 0.70 s to cold
index work, 0.88 s sampled self to native `put`, and 0.85 s to React stacks.
Those profile values are approximate and overlapping; they describe where to
look, not independent savings or timings of the rebased runtime. Pool constructor
work itself was only 5–10 ms. Bundle growth remains another measured input.

The narrow fix moves native submission off the first large blocking task while
retaining the full durable transaction. It does not remove the data, shrink the
bundle, or eliminate cold indexing and screen preparation. The remaining work
still needs a clean matched OLD corpus capture to establish the original budget.
