# HTTP sync measurements: historical probes and revised plan

Status: **re-baseline required; heavy runs held for disk headroom**. Fresh paired arms are approved by POD-3933. No after/before speedup, responsiveness improvement, or bounded-producer-memory claim is established by this document.

The identity failure below is **pre-POD-3931 history**, not a defect removed by this programme. Commit `5133399843e` predates the send/drain fix `b6c4e9b2e`; the current old transport already contains that fix. The repetitive corpus achieved roughly **1,182× compression** (decoded JSON / Zstd envelope bytes), so all existing results here are pipeline-behaviour probes, not representative performance claims. They must not be compared to a production-like 6× corpus.

POD-3933 has instructed this issue to use current `dev/mw` as the new baseline, retain every existing after run—including the coordinator's—as **historical JS-paced reads with socket backpressure unverified**, and hold large corpus generation until the coordinator confirms disk headroom. The observed baseline candidate on receipt was `d958a17c3c9e916d3bab9741422d92d049dcfa79`; its ancestry includes `b6c4e9b2e`. POD-3933 subsequently pinned that exact SHA as the BEFORE arm. Use it rather than silently following later movement of dev/mw; record the current integration tip as the AFTER arm. Do not move dev/mw or this issue onto the baseline.

## Comparison results

**No eligible comparison results yet.** Every number published as a programme result must come from a fresh paired, interleaved experiment: BEFORE `d958a17c3c9e916d3bab9741422d92d049dcfa79`, AFTER the integration tip. Capture contemporaneous load and process inventory per sample, report achieved compression ratio beside each result, and establish that socket backpressure actually stalled progress. Historical observations are context only and must never populate this comparison section or serve as either arm.

## Commits, box, and scope

New baseline runs use source commit `5133399843e81b7c6a7b4ebac51ed9d45bf0a045`, exported without moving a branch. All baseline numbers below were measured on **ludovico**, Linux, Bun 1.3.14, with a separate Node v22.22.2 client. Initial checkout/integration HEAD was `55740153f95cc897ddc3470f67f1dc46aba04ad2` and its ancestry check passed.

The `sync-gate` lease covered the full-size baseline runs. It coordinates participating sessions; it does not suspend unrelated host work. Initial host preflight reported load 12.19/12.07/14.12 and 6.5 GiB available on a 99%-used filesystem. Per-run contemporaneous load and process inventories are in the baseline evidence artifact. The highest CPU entries included unrelated `podium-cli` processes and agent processes; no causal load attribution is made.

The server is a loopback Bun host using production `Authority`, visibility policy, `FeedServing`, `OrderedClientSend`, and the legacy `WriteFunnel.feedChangesSince` through a minimal tRPC router. It uses the reference's 16 MiB socket send limit. It excludes production authentication, proxying, daemon assembly, desktop shells, and browsers. Health and WebSocket control ping/pong use this same Bun server.

## Corpus

`scripts/sync-measurements/corpus.mjs` uses `openTestStore` and the same append seam used by `feed-bootstrap-scaling.test.ts`. It creates 5,120 publicly visible repo rows. Each payload is a JSON object containing 10 KiB of repeated ASCII `x`, totaling **52,485,120 payload bytes**, before transport fields. One ordinary user can see the entire world. This is a payload-scaling corpus, not a realistic ownership/grant distribution or compression-ratio estimate.

After the initial world, 20,000 updates cycle through those same keys. The retained range is `(5120, 25120]`; its payload total is 205,020,000 bytes. The latest world remains 5,120 keys. The generator verifies the range length and latest payload size and writes a manifest next to the database. Fixture generation and dependency installation are outside measurement windows.

## Methodology and definitions

- Fresh server and fixture for each measured mode/coding. The corpus is highly compressible by construction.
- Bootstrap first-record latency counts request initiation to the first completely decoded record. Completion counts initiation to the final decoded bootstrap record, including Node parsing. Failed transfers have no completion latency.
- Bytes count message/envelope payloads for WebSocket and HTTP body bytes for HTTP, excluding transport headers and TCP framing. Decoded bytes count JSON text, including protocol fields.
- Main CPU counts Linux `/proc/<pid>/task/<pid>/stat` fields 14+15, divided by `getconf CLK_TCK`. Busy percentage is main CPU / wall over the **probe window**, which includes opening the ping socket and finishing outstanding probes. It is not precisely the body-transfer window. Client CPU is excluded; serving the probes is included.
- RSS is sampled externally every 20 ms. It includes the store, indexes, allocator retention, worker/native allocations, and transfer storage. Peaks shorter than the sampling period can be missed. Process high-water RSS includes fixture generation and is not used as transfer peak.
- Each health/ping probe waits for its preceding result and then waits 10 ms. Percentiles use nearest rank. Short transfers produce very few samples, explicitly reported below; these p95 values are descriptive, not statistically robust budget evidence.
- The slow consumer uses a paused Node `net.Socket`, reads at most 64 KiB every 500 ms, and stops after 30 seconds. It has no fetch/body handler draining native networking in the background. Node's readable buffer peaked at 127,104 bytes; kernel buffers provide additional bounded slack. This is a cancelled observation window, not a completed 50 MiB slow transfer.
- Delta client memory includes a Node Map sink that validates page chaining and installs changes. It does **not** run the production Replica kernel or persistence adapter. Its peak RSS is sampled every 5 ms and at application boundaries; synchronous JSON parsing can hide a transient peak.

## History: pre-POD-3931 tree and unrealistic corpus

All rows in the following tables have the baseline SHA, box, and scope stated above. Times are milliseconds. Load is 1/5/15-minute load average. Start times are UTC on 2026-09-15.

| Mode | Start UTC | Start load | End load | Outcome |
| --- | --- | --- | --- | --- |
| bootstrap/identity | 15:09:02.720 | 10.11/13.25/14.12 | 10.11/13.25/14.12 | failed before final record |
| bootstrap/zstd | 15:09:15.569 | 11.27/13.34/14.13 | 11.27/13.34/14.13 | complete |
| concurrent/identity | 15:09:26.635 | 10.77/13.17/14.07 | 13.14/13.41/14.11 | 4 fast transfers failed; slow reader cancelled |
| delta/identity | 15:10:20.259 | 15.71/13.97/14.28 | 15.71/13.97/14.28 | complete |

| Mode | Probe wall ms | Main CPU ms | Main busy % | Sampled server peak RSS MiB | Health n / p50 / p95 ms | Ping n / p50 / p95 ms |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| bootstrap/identity | 266.29 | 170 | 63.84 | 492.58 | 2 / 22.31 / 123.03 | 2 / 4.57 / 139.67 |
| bootstrap/zstd | 483.45 | 170 | 35.16 | 451.59 | 5 / 58.34 / 129.30 | 5 / 65.40 / 140.90 |
| concurrent/identity | 30478.60 | 5840 | 19.16 | 548.98 | 1612 / 2.71 / 21.30 | 1611 / 1.91 / 18.49 |
| delta/identity | 2960.75 | 1340 | 45.26 | 1267.48 | 21 / 11.20 / 505.52 | 21 / 22.38 / 506.13 |

### Bootstrap

Identity closed before the last record at the reference production limits. The harness did not retain partial-record counters for this first baseline, so first-record latency and partial body bytes are unavailable. A failed transfer's elapsed window must not be presented as a faster completion.

Zstd delivered all 5,120 rows in 26 records: first record **227.75 ms**, completion **455.06 ms**, **52,939,691 decoded JSON bytes**, **44,800 binary-envelope bytes**. Legacy WebSocket bootstrap has no gzip representation; a gzip baseline is **not applicable**, not zero.

### Concurrent readers

The baseline opened four fast identity bootstrap clients and one raw slow reader. All fast transfers closed before completion. The slow reader consumed **2,944,256 bytes including headers/framing** over its observation window. Those baseline connections shared the same user principal and could reuse the principal world cache. The current runner assigns distinct users with the same public slice because the HTTP endpoint supersedes concurrent requests for the same user. A fresh pair must use identical principal placement; these first concurrency observations cannot serve as that pair.

The apparently low 30-second-window p95 and busy ratio do not prove healthy transfer responsiveness: the fast transfers failed early, leaving much of the window dominated by probes and slow-reader waiting.

### Delta

The legacy tRPC path returned all **20,000 changes in one page**. First page reached the Node sink at **2,911.30 ms**; install completed at **2,922.47 ms**. Initial client RSS was **66,363,392 bytes** and sampled peak client RSS was **599,203,840 bytes** (571.45 MiB). The sink retained 5,120 keys after applying repeated updates. This is a transport-plus-Map heal, not production-kernel end-to-end acceptance.

## History: POD-3938 JS-paced reads, backpressure unverified

These are reproduced as historical evidence, as requested. The artifact's revised account states that the implementation/corpus were unchanged, while the integration base and dependency graph changed. Hostname and contemporaneous load were not recorded in that artifact. Its two runs cannot be retrospectively interleaved with the new baseline. Host contention is plausible but is not an established cause of the difference.

| Source SHA | Enclosing runner start (Europe/Berlin) | Body bytes | Probe wall ms | Main CPU ms / busy % | Health n / p95 ms | Ping n / p95 ms | Box / load |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| `548d7c94b` | 2026-09-15 16:17:34 | 52,875,330 | 1,923.85 | 720 / 37.43% | 142 / 22.97 | 199 / 8.78 | not recorded |
| `55740153f` | 2026-09-15 16:28:08 | 52,875,330 | 3,338.52 | 1,430 / 42.83% | 161 / 42.57 | 215 / 23.21 | not recorded |

Historical scope: one identity HTTP bootstrap, a real worker, health/ping probes, and the consumer **inside the same Bun process**. The consumer slept 2 ms after each body read. Main CPU therefore includes client/probe work, unlike the new baseline. There were no four concurrent bootstraps and no demonstrated socket backpressure. These p95 values met that probe's 100 ms budget, but they do not satisfy the requested concurrent slow-socket acceptance.

## Thread accounting and trace

The baseline artifact contains 20 ms `/proc` timelines, per-TID names/ticks, and start/end thread accounting. No Bun loop-delay histogram, ELU, JSC sampling profiler, or perf capture was used. Zstd's baseline main thread consumed 170 ms; its named Bun pool threads consumed 10 ms in total over the observed window. Other TIDs include GC/JIT work and are reported separately, not mislabeled as producer CPU. Threads that exit between samples may be missed.

No full-size after trace has been captured, so this evidence does not yet demonstrate the after pipeline running off the main thread. RSS cannot honestly be partitioned into prefetch maps and transfer buffers from `/proc` alone. The worker exposes heap-before/heap-after-prefetch counters and total process RSS; those are different quantities and must not be subtracted into a purported RSS allocation breakdown.

## Runner and outstanding evidence

The runner is `scripts/sync-measurements/run.mjs`. It supports baseline-only runs and A/B/B/A arms, refuses overwriting a run directory, creates isolated fixtures/processes, records per-run conditions, and prints a table. It uses source exports and separate checkout-local dependencies. It is a benchmark script, not a Vitest lane.

```sh
podium lock acquire sync-gate --ttl 20m
bun --conditions=@podium/source scripts/sync-measurements/run.mjs <reference-copy> . <fresh-output-directory> both
podium lock release sync-gate
```

The reference copy must contain the exact baseline commit and have its own `bun run setup:worktree` installation. Renew the lease for longer runs. Do not share node_modules. The committed runner is a historical prototype and is not ready for the corrected comparison: it still hardcodes the obsolete SHA and groups modes within each arm. Apply the revisions below before any full run. Do not execute this recipe while the coordinator disk hold is active.

Fresh full-size paired measurements are approved; the historical-reuse ambiguity is resolved. Execution is held until POD-3933 confirms disk headroom. The current runner additionally records WAL growth under periodic writes; that instrumentation was added after the first baseline and has no full-size result yet. HTTP gzip/zstd and delta tiny-fixture smoke checks are harness checks only.

Remaining acceptance includes controlled paired runs, producer/queue bounds and 503 saturation evidence, WAL growth while a confirmed snapshot remains open, a defensible memory attribution method, production Replica harness evidence, and the full-size after thread timeline. No tuning or production-code change is included.

## Checkpoint validation

The benchmark checkpoint was rebased onto integration commit `e79b8c766f3b2dfc83c49ebeff609bebd6a883fc`. `bun run test` was **lean gate green**: 26 successful typecheck tasks (25 cached), span-effect lint green, and 126 tests executed in 4 of 1,338 collected files. This does not validate the missing measurement acceptance. The issue remains in progress, with no merge performed.

## Revised experiment design during the disk hold

This section is a design, not evidence that the revised instrument has run. No new large database, source archive, build, or benchmark was started after the hold.

### Corpus with representative compressibility

Generate deterministic, row-specific payloads from a fixed seed: combine unique pseudo-random text with locally repeated structured text, rather than reusing one identical string across every row. Calibrate the entropy fraction on a small in-memory sample through the actual per-record gzip/Zstd encoding paths. Target approximately 6× for Zstd; report achieved ratios for each coding instead of forcing gzip to match. Record the seed, generator version, calibration size, and entropy fraction.

Then validate the achieved ratio on the complete wire stream. The sample is only a calibration aid: it cannot certify the full-corpus ratio. Use a predeclared broad acceptance band (proposed 5–7× for Zstd), adjust the corpus before timed runs if outside it, and keep the resulting bytes identical across paired arms. Count scoped JSON bytes separately from payload bytes and require at least 50 MiB of scoped JSON. Report decoded/body-byte ratio beside every result, with identity approximately 1× and gzip/Zstd ratios independently measured. Do not use timings to choose a seed or tune the corpus.

Keep the repetitive historical corpus as a separately named control. The original sender failure remains attributable only to the pre-POD-3931 commit; repeat identity on the corrected baseline with both corpus shapes without assuming it will fail.

### Faithful corrected WebSocket arm

Use the baseline's production `NativeGatewaySocket` from `gateway/ws-server.ts`, including native drain forwarding, and expose `OrderedClientSend.sendSequence` to `FeedServing`. The current prototype exposes only `send` and no drain subscription; reusing it would bypass the very fix the new baseline must include. Match native socket limits to that source commit, including its extra single-frame headroom. Sample `OrderedClientSend.stats()` without changing production behavior: pauses, accepted bytes/frames, queued/ready bytes, socket buffer peaks, and completion/failure reason.

Use equivalent distinct user principals with the same visible corpus for concurrent arms. This avoids HTTP's per-user supersession while preserving comparable scoping and cache behavior. Pin source SHAs and reject unspecified or obsolete baseline provenance instead of hardcoding the old reference.

### Backpressure proof that can fail

1. Run the consumer in a separate process on a raw TCP socket. Read only the handshake/headers, then stop application reads. Observe the TCP connection using a read-only socket diagnostic such as `ss -tinm`, correlating the client/server port pair, kernel queue sizes, and available receive-window information. The existing bounded Node buffer is necessary but does not prove the server stalled.
2. During a sustained stopped-reader interval, record server progress. For WebSocket, require native `-1`/pause evidence, outstanding buffered bytes, and no continued application-send advance until drain. For HTTP, observe the production response-body relay's pull/chunk counters and completion state from a benchmark wrapper: require outstanding work and a stable progress plateau after bounded kernel/native slack fills. Correlate that plateau with TCP queue evidence. Bun HTTP does not expose the WebSocket send-return API; do not call a JavaScript plateau an observed blocking syscall.
3. Resume at 64 KiB per 500 ms. Record actual bytes/read times, resumed server progress, and completion of the full response. Compare with a fast control and a second imposed rate on the same corpus. Completion wall must track delivered bytes / imposed rate after accounting for initial kernel/native slack. A fixed 30-second cancellation alone cannot satisfy this check.
4. A 50 MiB identity body at 128 KiB/s takes roughly 400 seconds before overhead. Plan the lease and stream deadline accordingly; separate a shorter stop/resume proof from the full rate-controlled completion. Do not use the long idle/throttled interval to claim a low main-thread busy fraction without also reporting the active-transfer window.
5. Fail the proof if no server stall is observed, if the native body drains completely during the stopped interval, if resumption fails to advance, or if the observed rate/wall relationship is inconsistent. Preserve the failed proof as an instrument result, not a transport performance result.

### Pairing, queue, memory, and WAL

Interleave A/B/B/A **within each mode and coding**, using the same fixture bytes and reader placement. Record a load/process snapshot for every arm under `sync-gate`; the lease does not make unrelated processes disappear. Report paired samples and their ratios, not an aggregate mixing successful and failed transfers.

For admission, hold the worker's two active jobs under demonstrated socket backpressure, fill the eight queued reservations with distinct principals, then require excess requests to return 503 with Retry-After. Record cleanup and released reservations after abort. Use actual runtime constants from the measured SHA; do not treat the planned limits as observed queue behavior.

Take an external per-thread CPU/RSS timeline, worker heap-before/after-prefetch metrics, and sender/relay-owned buffer counters. Distinguish measured process RSS from isolate heap and explicit buffer ownership. A process RSS subtraction is not a defensible split into maps versus buffers. Identify the producer's OS TID rather than aggregating GC/JIT/pool threads under a worker label.

Measure WAL size and append counts while a confirmed snapshot remains open during the stalled reader; demonstrate snapshot release on completion/abort. Fixture writes must preserve corpus row count and payload scale. Document the production Replica adapter and persistence semantics for the Node heal measurement; the existing Map sink remains only a transport probe.

### Resume conditions

POD-3933 must first confirm reclaimed disk headroom. Then finish the above harness revisions, use the pinned baseline `d958a17c3c9e916d3bab9741422d92d049dcfa79` and record the integration SHA, run a tiny smoke, and capture the fresh paired experiment under the lease. The issue remains in progress. The prior lean gate belongs to the historical checkpoint; this documentation-only correction does not change runtime and does not require another test run.
