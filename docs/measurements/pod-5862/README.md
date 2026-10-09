# Native transcript search memory

`TranscriptSearchIndex` eagerly retained n-gram postings and per-block gram sets
for every loaded transcript, even with an empty search. Both the main thread and
the compute worker owned a copy. The fix builds the incremental index for an
observed search and releases it when the last reader leaves. Snapshot searches
retain no index; they reuse a watched index when one already exists. The worker
disposes its search reaction when its model is replaced or forgotten.

The native removal experiment used the archived `0.1.1-dev.283+de058fe` frontend
with the operator's live records. Main-thread memberships rose from 100,531 to
859,442 as loaded items rose from 200 to 2,027. At minute 7, the experiment cleared
both search indexes, including normalized text copies, and suppressed further
gram creation. Raw transcripts, paging, rendering and live intake continued.
From minutes 8 to 15, items doubled from 2,849 to 5,674 and attached DOM elements
rose from 44,716 to 94,403; native footprint was 2,964 then 2,984 MiB. Both posting
counts stayed zero. The remaining samples include GC fluctuations through minute
18, when an SSH timeout ended that collector.

The fixed capture completed 25 minutes with 26 samples, no application errors and
no memory-budget stop. It loaded 8,058 items and retained zero n-gram memberships
on both threads throughout. The final five samples were idle, with live intake
and rendering still active: footprint fluctuated between 3,528 and 4,450 MiB and
ended at 4,168 MiB, below the first idle sample's 4,424 MiB. Paging increased the
raw data and rendered DOM; the whole process does not have a flat footprint while
that working set expands. The eliminated index owner has a flat zero-state curve,
and the idle footprint shows no continuing upward trend in this interval.

The fixed frontend, `23fec0a035e97985137edc213ed089841565f050`, is the reported
source plus only the two product files, verified byte-identical to the pilot
candidate. It was built on flatblock in a separate checkout with frozen,
checkout-local dependencies. This matched comparison was necessary because the
pilot's wire schema differs from the live backend. Both native captures use wire
version 4 and schema digest `2f07b2a7138c6655`; neither bypasses the schema guard.

These are AppKit WKWebView captures on the leased Tart runner, macOS/Safari 26.6.2,
rather than a capture inside the installed Tauri shell. A unique 2.5-second CPU
burst identifies the page's WebContent process. `proc_pid_rusage` then measures
physical footprint and resident memory. The website data store is nonpersistent,
and the session credential travels through an unnamed pipe. Diagnostic worker
hooks export only cardinalities; the fixed worker has no removal/freeze handler.
The collector survives SSH disconnections and terminates above a 7 GiB footprint.

The reported 17 GB threshold was not reproduced. WebKit provides no
`performance.memory` in this host. DOM measurements count attached elements;
listener metrics count registration/removal calls, rather than unique listeners.
MobX counts cover selected transcript graph atoms, and origin storage usage is an
estimate rather than an exact IndexedDB byte census. The earlier Chromium and
synthetic Safari captures are cost/baseline evidence, not the native causal proof.

All formal validation ran sequentially and in the foreground on flatblock, using
its checkout-local Bun 1.4.2 and `node -> bun` link. The final rebase base is
`ff68b5e727`; the product files did not change after these checks.

| Check | Result |
| --- | --- |
| Focused search-index and transcript-graph files | 13 tests passed |
| Focused compute-worker file | 2 tests passed |
| Full `bun run typecheck`, every project, on rebased candidate `6e717016ab` | 29/29 tasks successful |
| Lean `bun run test`, after restoring generated API types | Green: 4 of 1,863 files, 154 tests; required lints green |
| `bun scripts/check-interaction-scans.ts` | 2,235 fingerprints; 0 ratchet errors; classifications unchanged |
| Normal `apps/web` production build | Green on the rebased source (`a534b61a58`) |
| Full `bun run speed:structural` on rebased candidate `6e717016ab`, under `meter:flatblock` | 3 files, 30 passed / 7 selected-out tests; 0 unexpected counters; peak recorded process RSS 4.9 GiB; no budget stop |

[Removal samples](native-counterfactual.json) and [fixed samples](native-fixed.json)
contain only public numeric evidence. To render the standalone interactive report:

```sh
python3 docs/measurements/pod-5862/native-evidence.py \
  --baseline docs/measurements/pod-5862/native-counterfactual.json \
  --fixed docs/measurements/pod-5862/native-fixed.json \
  --out docs/measurements/pod-5862/memory-evidence.html
```

The issue artifact holds that HTML separately from the repository. `wk-capture.swift`,
`wk-meter.py`, `wk-launch.py`, `wk-probe.js` and the two worker instrumentation
scripts reproduce the native setup; `wk-idle-phase.js` queues the normal idle phase.
`flatblock-validate.py` records descendant PIDs from every parent thread, enforces
the admission floor and relevant worker/structural budgets, and saves exit results.
