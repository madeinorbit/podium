# HTTP sync: fresh paired measurements

**Confirmed backpressure regression; acceptance remains blocked.** The current WebSocket sender pauses behind a closed receive window and resumes at the imposed rate. The HTTP producer completes the entire world despite that same TCP restriction. This programme regresses a backpressure property already provided by POD-3931; matching the baseline pause/resume behavior is a remediation requirement. Fresh paired bootstrap and production Replica observations are available. POD-4022 tracks substantially longer HTTP bootstrap completion; POD-4023 blocks admission cancellation cleanup. POD-4025 records a failed HTTP producer-backpressure proof despite confirmed TCP receive-window restriction. Bounded native response memory remains unestablished; no review-ready claim is made.

## Experiment and provenance

All comparison rows below come from fresh sequential before/after pairs on **ludovico**, Linux, Bun 1.3.14 and a separate Node v22.22.2 client. BEFORE is `d958a17c3c9e916d3bab9741422d92d049dcfa79` and includes POD-3931. AFTER is the integration tip recorded in each row; the runner refuses a production-tree difference between its checkout and that tip. Integration advanced from `e79b8c766f3b2dfc83c49ebeff609bebd6a883fc` to `dc389b4143a53c1bd46eb7ee7d5a66a9a1a687e2` between modes; each actual SHA is preserved. Only one heavy run ran at a time under `sync-gate`.

These are **single pairs per mode/coding**, not repeated statistical estimates. Load was high and variable. Per-sample UTC time, load averages, process inventory, disk snapshots, raw thread counters and manifests are attached as **Fresh paired bootstrap and Replica samples** and **Raw paired samples and admission failure**. Interleaving limits time drift; it does not isolate code from scheduler contention. No causal attribution follows from these observations alone.

The fixture host uses production Authority/visibility, FeedServing, NativeGatewaySocket, native drain forwarding and OrderedClientSend.sendSequence for the legacy arm; HTTP routes and the real SyncWorkerClient for the after arm. Worker-channel telemetry is passive: it does not replace a stream or reader or issue credits. The host provides loopback health and native WebSocket control ping/pong. Authentication is fixed to fixture users. Production auth, daemon assembly, proxies, TLS, browser and desktop behavior are outside this scope.

### Corpus

The store harness creates **5,120 public repo rows** with 10 KiB text payloads, visible to one ordinary user. A fixed xorshift seed supplies 2,200 row-specific base64-alphabet symbols per payload, followed by repeated text. Payload JSON totals **52,485,120 bytes**; actual decoded transport JSON is about 52.94 MB, above 50 MiB. Full-stream Zstd ratios are **6.195× before and 6.194× after**, meeting the predeclared 5–7× band. Gzip achieved 6.039×. These are synthetic content ratios resembling the supplied production target, not a production ownership/grant distribution.

The next **20,000 appended updates** cycle through those same keys, retaining `(5120,25120]` while keeping the latest world at 5,120 keys. Payload bytes for that range total 205,020,000; wire JSON is about 206.77 MB. Manifests record seed, entropy fraction and payload SHA-256. Fixture generation is outside transfer timing. Concurrent connections use distinct users with the same public slice, avoiding HTTP per-user supersession and matching legacy cache placement.

### What each number counts

- Bootstrap first record: request initiation to first fully decoded record. Completion: initiation through complete decoded bootstrap delivery. HTTP includes meta/complete records; WebSocket uses its final bootstrap record. Decoded bytes count protocol JSON; coded bytes count HTTP body bytes or WebSocket binary-envelope payloads, excluding TCP/HTTP/WS framing. Ratio is decoded / coded bytes.
- The legacy path has no gzip bootstrap representation. The gzip pair deliberately compares a **fresh legacy identity run** with HTTP gzip. It is labelled as such, never as legacy gzip.
- Main CPU is `/proc/<pid>/task/<pid>/stat` utime+stime, with `getconf CLK_TCK`. Busy fraction divides that CPU by the whole probe window, including probe settlement. Server probe handling is included; external client CPU is excluded. Absolute main CPU is shown alongside the fraction because a longer denominator can make a slower transfer look better.
- The producer CPU column counts the unique OS thread named `Worker` in the after host. GC, JIT and Bun pool threads are preserved individually in the raw evidence and excluded from that column. No ELU, Bun loop-delay histogram, JSC sampling profiler or perf capture was used.
- Server RSS is sampled externally every 50 ms; a shorter peak can be missed. It includes store/index state, worker memory, transfer/native buffers and allocator retention. Per-job worker heap and metadata-phase RSS are separate quantities, not an exact RSS allocation split.
- Health/ping loops wait 25 ms after each response. Percentiles use nearest rank and include sample counts. Short fast runs have very few samples; their p95 is descriptive, not a robust budget test. The long slow-reader window must not conceal the initial overlap of the four fast bootstraps.
- Delta uses each source tree's **production Replica**, **InMemoryReplicaStore**, unit-of-work boundary, and production wire mapper under Node. It starts with the full fixture world/cursor, invokes the real heal port, and verifies live posture, final cursor and key count. No disk persistence is measured. Internal RSS sampling is supplemented by external client process-lifetime high-water RSS; that latter number includes module loading and seeding.

## Fresh paired bootstrap observations

Milliseconds except bytes/ratio. Source aliases: B=`d958a17c3c9e916d3bab9741422d92d049dcfa79`; H=`e79b8c766f3b2dfc83c49ebeff609bebd6a883fc`. Every row is scoped to one complete fixture transfer on ludovico.

| Pair | Arm / actual coding | SHA | First record ms | Completion ms | Decoded bytes | Coded bytes | Achieved ratio |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| identity | before / identity | B | 129.12 | 444.42 | 52,939,691 | 52,939,691 | 1.000× |
| identity | after / identity | H | 339.56 | 2407.73 | 52,943,466 | 52,943,466 | 1.000× |
| gzip | before / identity | B | 107.23 | 574.62 | 52,939,691 | 52,939,691 | 1.000× |
| gzip | after / gzip | H | 251.79 | 8375.27 | 52,943,466 | 8,766,768 | 6.039× |
| zstd | before / zstd | B | 215.62 | 495.27 | 52,939,691 | 8,545,281 | 6.195× |
| zstd | after / zstd | H | 324.97 | 8698.03 | 52,943,466 | 8,547,325 | 6.194× |

| Pair / arm | Probe wall ms | Main CPU ms | Main busy % | Producer CPU ms | Server peak RSS MiB | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| identity / before | 485.20 | 290 | 59.77 | N/A | 437.77 | 1.000× |
| identity / after | 2443.67 | 620 | 25.37 | 950 | 451.62 | 1.000× |
| gzip / before | 615.86 | 310 | 50.34 | N/A | 459.05 | 1.000× |
| gzip / after | 8385.99 | 1130 | 13.47 | 1400 | 410.54 | 6.039× |
| zstd / before | 499.04 | 180 | 36.07 | N/A | 427.75 | 6.195× |
| zstd / after | 8728.59 | 1240 | 14.21 | 1440 | 400.59 | 6.194× |

Both current identity arms completed. This corrects the obsolete baseline story: the current WebSocket path does not exhibit the historical cutoff in this fixture. HTTP's busy fraction was lower, but its absolute main CPU and completion time were higher. Zstd completion was about 17.6× longer in this pair, despite near-identical compression ratios; POD-4022 owns follow-up, not a tuning change here.

## Fresh paired production Replica heal

Both identity-coded runs applied 20,000 rows to a seeded 5,120-key world and ended live at seq 25120. Ratio is 1× for each. BEFORE uses B above; AFTER uses `dc389b4143a53c1bd46eb7ee7d5a66a9a1a687e2`. Scope is the in-memory production Replica path on ludovico.

| Arm | First page ms | Complete heal ms | Pages | Decoded bytes | Internal sampled client peak MiB | External lifetime client peak MiB | Server peak MiB | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 7237.51 | 7294.01 | 1 | 206,770,812 | 840.95 | 1035.36 | 1153.94 | 1× |
| after | 494.88 | 17195.58 | 40 | 206,776,518 | 481.06 | 482.68 | 802.80 | 1× |

Paging materially advanced first-page delivery and reduced memory in this pair; total heal time increased. The legacy byte count is reserialized reply JSON excluding the tRPC envelope, while HTTP counts its NDJSON body; this small framing difference is explicitly outside an exact wire-byte comparison.

## Responsiveness during the measured windows

Each row uses its transfer's SHA above, ludovico, and its contemporaneous conditions below. H/P mean health/ping; values are sample count / p50 / p95 in milliseconds. These are transfer-window observations; the concurrent slow-reader acceptance is separate.

| Mode / pair / arm | H n / p50 / p95 | P n / p50 / p95 | Main CPU ms / busy % | Ratio |
| --- | --- | --- | --- | ---: |
| bootstrap / identity / before | 7 / 21.00 / 65.94 | 7 / 20.43 / 92.40 | 290 / 59.77% | 1.000× |
| bootstrap / identity / after | 46 / 7.85 / 66.30 | 47 / 6.58 / 65.94 | 620 / 25.37% | 1.000× |
| bootstrap / gzip / before | 7 / 40.30 / 145.79 | 7 / 30.51 / 101.82 | 310 / 50.34% | 1.000× |
| bootstrap / gzip / after | 229 / 4.82 / 30.89 | 231 / 3.81 / 24.93 | 1130 / 13.47% | 6.039× |
| bootstrap / zstd / before | 4 / 42.92 / 135.53 | 4 / 42.52 / 132.39 | 180 / 36.07% | 6.195× |
| bootstrap / zstd / after | 239 / 4.30 / 32.02 | 239 / 3.72 / 24.91 | 1240 / 14.21% | 6.194× |
| delta / identity / before | 18 / 11.69 / 4933.94 | 18 / 11.34 / 4943.13 | 2280 / 29.16% | 1.000× |
| delta / identity / after | 40 / 259.34 / 538.11 | 40 / 261.47 / 527.99 | 2720 / 15.40% | 1.000× |

## Conditions and disk discipline

UTC on 2026-09-15. Load is 1/5/15-minute average. Space is available GiB before fixture generation, at run end before cleanup, and after database/WAL cleanup. Negative net consumption can reflect unrelated reclaim and is not attributed to this runner. All full runs required at least 3 GiB before starting and stopped on net consumption above 1 GiB. Full per-sample process inventories are in the attached JSON.

| Mode / coding / arm | UTC start | Load start → end | Free GiB start / end / cleaned | Ratio |
| --- | --- | --- | --- | ---: |
| bootstrap / identity / before | 15:41:31.155 | 13.05/15.73/15.29 → 13.05/15.73/15.29 | 4.79/4.46/4.82 | 1.000× |
| bootstrap / identity / after | 15:41:44.796 | 12.33/15.49/15.22 → 13.27/15.63/15.27 | 4.82/4.46/4.82 | 1.000× |
| bootstrap / gzip / before | 15:42:09.075 | 13.83/15.62/15.27 → 13.83/15.62/15.27 | 4.82/4.46/4.82 | 1.000× |
| bootstrap / gzip / after | 15:42:27.294 | 17.81/16.34/15.51 → 18.73/16.58/15.60 | 4.82/5.28/5.63 | 6.039× |
| bootstrap / zstd / before | 15:42:53.829 | 19.26/16.79/15.69 → 19.26/16.79/15.69 | 5.63/5.27/5.63 | 6.195× |
| bootstrap / zstd / after | 15:43:14.708 | 19.88/17.11/15.82 → 21.08/17.46/15.94 | 5.63/5.27/5.62 | 6.194× |
| delta / identity / before | 15:44:19.666 | 18.40/17.35/16.00 → 18.41/17.40/16.03 | 5.61/5.26/5.61 | 1.000× |
| delta / identity / after | 15:44:42.538 | 19.12/17.61/16.12 → 18.79/17.66/16.17 | 5.61/5.25/5.61 | 1.000× |

## Admission and socket-backpressure failures

A fresh admission pair used the absent legacy HTTP route as an explicit 404 control, followed by twelve distinct HTTP bootstrap users with raw sockets that did not consume bodies. In the after pre-abort checkpoint, four had 200 headers, six remained pending, and two had **503 with Retry-After: 5**. Eight worker-client jobs remained; two prior workers had already emitted **52,943,466 bytes each and completed while readers were stopped**. **The producer emitted the entire world twice over with the consumers reading no application body bytes.** All requests negotiated identity (ratio 1×). This is capacity/failure evidence at `dc389b4143a53c1bd46eb7ee7d5a66a9a1a687e2` on ludovico, not a successful cleanup or sustained-backpressure claim.

Destroying the sockets then terminated the Bun host with `SyncWorkerError: cancelled` from worker-client.ts. POD-4023 blocks cleanup acceptance. The admission checkpoint preserves source SHA, contemporaneous load/process inventory, statuses and passive worker counters; failed-run disk snapshots and server diagnostics are retained. No post-crash RSS/CPU number is manufactured.

The fresh concurrent pair ran on ludovico with identity coding (achieved wire ratio **1×** in both arms), four fast readers and one stopped raw TCP reader. BEFORE source was `d958a17c3c9e916d3bab9741422d92d049dcfa79`; AFTER source was `dc389b4143a53c1bd46eb7ee7d5a66a9a1a687e2`. These are failure-mechanism observations, not a successful slow-reader performance comparison. Attached `socket-proof.json` carries source, load, TCP diagnostics and per-reader observations; the raw bundle carries contemporaneous process and disk snapshots.

| Observation and scope | BEFORE | AFTER |
| --- | ---: | ---: |
| TCP stopped-reader connection receive-window limitation | 100%, 4,443 ms | 100%, 4,710 ms |
| Producer while application body reads stopped | Paused; stable 4,135,994 sent bytes | All 52,943,466 bytes emitted; worker complete |
| Full slow-reader completion | 409,535.859 ms | Not measured: proof failed |
| Paced reading / ideal at 64 KiB each 500 ms | 404,001.260 / 403,901.039 ms | Not measured |
| Whole probe duration | 409,832.405 ms | 9,064.486 ms |
| Whole probe main-thread CPU / wall | 14.391% | 20.740% |
| Whole probe health / WS ping p95 | 32.926 / 30.094 ms | 92.674 / 92.695 ms |
| Whole probe peak server RSS | 827.027 MiB | 480.547 MiB |
| Start load average (1/5/15 min) | 25.25 / 22.28 / 18.82 | 19.40 / 22.09 / 20.06 |
| End load average (1/5/15 min) | 20.64 / 22.46 / 20.14 | 21.06 / 22.37 / 20.17 |

BEFORE's scheduled reading duration matched the imposed rate within 0.025%. The production sender remained paused with unchanged counters during the stop, then completed all 5,120 records. Its peak application queue was 8,271,988 bytes and finished empty. AFTER's worker completed in approximately 2.986 seconds while the application had consumed no body bytes; TCP still showed a closed-window-limited connection with approximately 2.85 MB unsent. This proves that TCP pressure did not constrain this producer. It does **not** establish an asymptotic native-memory bound or identify exactly which downstream layer held each byte. POD-4025 blocks acceptance; a second rate-control run would not repair this failed mechanism.

The whole-window CPU ratios and responsiveness quantiles above have different scopes: the legacy window is mostly the slow reader alone after four fast transfers finish, whereas the failed HTTP window ends after roughly nine seconds. Do not interpret their difference as an improvement or regression. Per-probe timestamps were not retained, so an equal-duration overlap-only responsiveness comparison cannot be reconstructed from these samples.

WAL began at zero in each arm. BEFORE applied 90 fixture updates during the stalled/paced transfer; WAL peaked at 3,881,072 bytes and final TRUNCATE returned it to zero. Its initial ten-write PASSIVE checkpoint reported 111 frames, all checkpointed: the legacy transfer did not hold a SQLite snapshot. AFTER's ten writes grew WAL to 457,352 bytes; PASSIVE reported 111 frames and zero checkpointed. Other fast-reader snapshots were still active, so that pin cannot be attributed to the already-completed slow-reader producer. The requested WAL growth specifically under a sustained HTTP slow-reader snapshot remains unestablished.

Further heavy runs stopped after the failed proof. Each run database/WAL was removed and the sync-gate lease released.

## Coarse completion diagnostic — existing paired Zstd sample

This diagnostic uses the same fresh after Zstd sample above: ludovico, source `e79b8c766f3b2dfc83c49ebeff609bebd6a883fc`, achieved ratio 6.194156×, start/end load 19.88/17.11/15.82 and 21.08/17.46/15.94. It is not an additional run. The paired baseline completed in 495.272 ms; after completed in 8,698.031 ms.

| Recorded scope | Time |
| --- | ---: |
| Worker admission queue wait | 0.377 ms |
| Worker pipeline elapsed, including waits | 5,106.893 ms |
| Capture snapshot phase | 11.444 ms |
| First visibility/prefetch pass | 115.102 ms |
| Second payload pass, including generator suspension | 4,849.082 ms |
| Explicit record JSON/UTF-8 encoding calls | 125.404 ms |
| Main-side job start to worker completion message | 5,119.989 ms |
| Worker OS-thread CPU over the full probe | 1,440 ms |
| Main OS-thread CPU over the full probe | 1,240 ms |

These scopes overlap. The compression counter (5,106.882 ms) measures the streaming pipeline lifetime, including waits, **not codec CPU**. The second pass includes yield/credit/consumer waits, parsing and size estimation; the explicit encoding counter does not count every JSON operation. Do not add these phase values or subtract CPU measured over the full probe to manufacture an exact wait duration.

The coarse result localizes roughly 5.1 seconds inside the worker pipeline; the approximately 3.58-second difference between client completion and main-side job duration remains outside that measured job interval, including request setup, downstream delivery and client processing. Those intervals lack synchronized boundary timestamps, so that residual is not a socket-wait measurement. Admission queueing and explicit record encoding alone do not explain the delay. Equal achieved compression ratios rule out a material compression-size penalty in this pair, but do not rule out codec or per-chunk overhead.

**Bridge waits versus socket waits are not separately instrumented.** This evidence narrows the question but cannot assign the 8.2-second paired completion gap among those causes. POD-4022 owns that remaining diagnosis; no tuning or new heavy experiment was attempted after the confirmed backpressure failure.

**Coordinator parking decision (2026-09-15):** the document is accepted as evidence; further measurement acceptance is parked pending the operator's transport decision. The coordinator reports that POD-4026 inspected Bun's response-stream implementation, falsified three proposed escapes and demonstrated bounded behavior in a Node control. This independently reported transport finding makes completion-cost attribution inseparable from the backpressure defect: client completion includes downstream buffering and delivery, rather than directly measuring producer delivery. POD-4022 therefore remains open because the transport boundary must be resolved, not because another run on this transport would provide the missing attribution.

The small explicit-record encoding and admission-queue counters exclude those measured scopes as dominant costs. They do not exclude all codec work or bridge waits: the encoding counter omits other serialization, the queue counter covers admission only, and worker CPU covers a different interval from pipeline wall time. No exact codec/bridge/socket decomposition is claimed. Existing production Replica observations remain valid within their stated scope; outstanding acceptance, including sustained HTTP memory/WAL behavior and the full after trace, is parked rather than certified.

## Memory attribution and thread evidence

The raw 50 ms timeline names each OS TID. In the after single-bootstrap samples, the unique Worker thread consumed 950 ms (identity), 1,400 ms (gzip), and 1,440 ms (Zstd); corresponding full-stream ratios were 1×, 6.039× and 6.194×. The worker's production phase metrics show capture, visibility pass, serialization and compression work. Phase durations overlap and are not additive; compression/transfer timing includes waits. The observations establish worker activity, not zero main-thread relay cost.

HTTP identity crossed in 814 worker chunks, each at most 65,536 bytes; gzip and Zstd used 1,351/1,336 chunks with maxima 12,055/11,840 bytes. These are worker-channel bounds only. They do not establish a bound on Bun's native response buffer, and completed producers behind unread clients make that distinction material.

Prefetch isolate heap change, RSS observed at metadata acknowledgement, and sampled transfer-window RSS are reported below. Metadata follows the production visibility pass, but asynchronous message delivery and native/allocator activity prevent an exact allocation split. Do not subtract these into fictitious 'map RSS' and 'buffer RSS'. The requested disjoint RSS split is **not established**; the report supplies the independently observable quantities instead.

| Coding / ratio | Worker heap before / after prefetch MiB | Process RSS at meta MiB | Sampled process peak MiB |
| --- | --- | ---: | ---: |
| identity / 1.000× | 22.98 / 25.06 | 338.55 | 451.62 |
| gzip / 6.039× | 22.92 / 24.82 | 360.10 | 410.54 |
| zstd / 6.194× | 22.95 / 24.93 | 352.39 | 400.59 |

## Reproduction and validation status

The benchmark files are under `scripts/sync-measurements/`: deterministic corpus, isolated production host, external Node client, and sequential runner. Export the pinned before tree without changing shared branches and install its checkout-local dependencies. Hold/renew `sync-gate`, then run:

```sh
bun scripts/sync-measurements/run.mjs <reference-copy> . <fresh-output-directory> both full <mode>
```

Modes include bootstrap, delta, admission, concurrent and rate-control. The runner records df before and after, removes each temporary database/WAL before the next arm, refuses overwrites and enforces the disk floor/stop rule. A known cancellation or proof failure stops that invocation; do not treat it as a green result.

Tiny fixtures exercised both bootstrap transports/codings, real Replica heal ports and raw protocol parsing. Rebased checkpoint `20897623a` onto integration `dc389b4143a53c1bd46eb7ee7d5a66a9a1a687e2`. The final `bun run test` was lean gate green: 26 typecheck tasks (25 cached), span-effect lint green, and 126 tests in 4 of 1,338 collected Node files. This is boot/wiring evidence, not a suite run or a passing benchmark acceptance claim. No specialized test lane was requested for these benchmark-only scripts; their smoke and fresh experiments are described above. The final coordinator-requested wording and coarse diagnostic are documentation-only changes; the lean gate was not repeated for them. No production tuning or merge is included; issue stays in progress while acceptance blockers remain.

## History — excluded from every comparison

- The first reference-commit probe used `5133399843e81b7c6a7b4ebac51ed9d45bf0a045`, before POD-3931. Its identity transfer failed before the last record. That ceiling was already fixed by `b6c4e9b2e`, so this programme gets no credit for removing it. Independently, the prototype lacked production NativeGatewaySocket drain forwarding and lazy sendSequence wiring; simply updating its source SHA would not have made it a faithful comparator.
- That first corpus repeated one payload and achieved about 1,182× Zstd compression. Its 455 ms Zstd completion and 2.92 s Map-sink delta heal on ludovico are historical pipeline probes, not performance arms. The delta sink was not the production Replica kernel. Original raw evidence remains on the issue.
- POD-3938's two historical identity observations (source commits `548d7c94b` and `55740153f`) used JS-paced body reads inside the server process. Their health p95 values were 22.97/42.57 ms, ping p95 8.78/23.21 ms, and main busy fractions 37.43/42.83%. Socket backpressure was unverified; hostname and contemporaneous load were not recorded in the source artifact. The coordinator's own verification run has the same JS-paced-read limitation. None is an after arm here.

- POD-3937 pipe backpressure tests used a JavaScript consumer, rather than closing a TCP receive window. Those tests could validate the pipe boundary but could not detect the Bun HTTP/socket boundary regression established here. Together with the historical JS-paced responsiveness probes, their green outcomes were insufficient evidence for end-to-end socket backpressure.
