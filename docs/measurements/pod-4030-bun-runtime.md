# Bun 1.4.2 production sync proof

## Conclusion

**Bun 1.4.2 propagates HTTP backpressure through the real sync endpoint to its worker.** On the full 52.94 MB fixture, identity, gzip and zstd plateau while a raw client reads nothing. The job and SQLite snapshot remain held; disconnect releases them, with one metrics event, one terminal event and one completion resolution per transfer. Paced readers resume successfully. Bun 1.3.14 instead continues draining the producer.

This is the programme's requested transport acceptance evidence, not repository-wide Bun compatibility or pre-merge validation. Measurements stopped at the operator's direction. Nothing was merged.

## Source, fixture and evidence

- Original control: `4aa17feaef1e51834fde6a41013e2858659ddf11`, then the integration tip. Its original evidence is preserved verbatim under `artifacts/pod-4030`.
- Fresh pairs: `9bd1a5231` (`Move the toolchain to Bun 1.4.2`). Both runtimes used identical production source and checkout-local dependencies. Ancestry was verified before measurement; `setup:worktree` performed the frozen checkout-local install. The report's later rebase onto `36e04fdbf` is a handoff rebase, **not a measurement of that newer source**.
- Executables: `/home/mgw/.local/bin/bun` reported 1.3.14; `/tmp/pod-4030-bun/bun-linux-x64/bun` reported 1.4.2. The latter was downloaded before the coordinator changed the task to use the upgraded integration pin. No toolchain pins were edited by this issue.
- POD-3946's existing fixture: 5,120 public repository rows, 20,000 retained updates, 52,485,120 payload bytes, 52,943,466 decoded transport bytes. Payload SHA-256: `a7fffe9c5eeb2fa7ba1da9693cb6ed7e3d715386afaf0e47e7bbdb9ed2f617b9`.
- Host: the existing `scripts/sync-measurements/server.mjs`, constructing real `registerSyncRoutes`, `SyncWorkerClient`, worker, SQLite store and content-coding pipeline. Only passive measurement-host observations were added. **No `apps/` or `packages/` source changed.** Authentication and daemon assembly are outside this isolated loopback fixture.
- Fresh evidence: `artifacts/pod-4030-fresh/<version>/<coding>-<disconnect|resume|bootstrap>/`. The issue's attached `pod-4030-evidence.zip` preserves JSON measurements, full `ss` observations, fixture manifests, captured-body hashes and the measurement scripts. Large HTTP body captures remain local; they are not included in the evidence ZIP.

## Raw never-reading comparison

The disconnect cases below make zero application socket reads before both checkpoints. The first checkpoint follows a three-second wait and the second a further two-second wait. Exact sample times are retained in JSON. TCP acknowledgement counts are from the **server** socket in `ss -tinm`, not the client's request acknowledgements.

| Coding | 1.3.14 worker bytes, first → second | 1.4.2 worker bytes, first → second | Server bytes acknowledged, 1.3.14 / 1.4.2 | Worker state at second checkpoint |
| --- | ---: | ---: | ---: | --- |
| identity | 52,943,466 → 52,943,466 | 2,027,713 → 2,027,713 | 4,660 / 4,660 | old complete; new held |
| gzip | 2,270,705 → 6,237,855 | 1,982,464 → 1,982,464 | 4,621 / 4,622 | old advancing; new held |
| zstd | 3,604,480 → 8,547,329 | 1,981,777 → 1,981,777 | 4,613 / 4,613 | old complete; new held |

The original pre-rebase identity control also emitted **52,943,466 bytes with zero client reads and 4,660 bytes acknowledged**. Its one-credit window stayed bounded even though Bun drained the entire worker response. That original A arm is retained unchanged.

All fresh observed credit windows peaked at **one outstanding credit**. Largest observed worker chunks were 65,536 bytes for identity, 12,055 for gzip and 11,840 for zstd. The 1.4.2 disconnect cases' sampled RSS stayed flat or slightly declined between checkpoints: identity 308,652 → 308,652 KiB; gzip 314,740 → 314,740 KiB; zstd 321,160 → 321,092 KiB. These whole-process figures include fixture/store overhead; they are not the bare boundary probe's RSS or a general memory-scaling guarantee.

## Snapshot hold and exactly-once release

For **each 1.4.2 coding**, both the disconnect and paced-resumption cases showed:

1. One active main-thread worker-client job at the unread checkpoints, no terminal completion, and stable worker byte counts. The zstd resumption transfer plateau was 1,981,778 bytes; its independent transfer UUID differs from the disconnect case.
2. Ten fixture writes after the checkpoints produced 111 WAL frames. `wal_checkpoint(PASSIVE)` reported **111 log frames, zero checkpointed** while the reader remained stopped: the worker's read snapshot was still holding the WAL.
3. After RST, or after paced completion, **jobs = 0**. Per-transfer `metricsCount`, `terminalCount` and `completionCount` were each **1**, unchanged at the second post-release observation. RST outcomes were `cancelled`; completed readers ended normally.
4. `wal_checkpoint(TRUNCATE)` returned **busy = 0, log = 0, checkpointed = 0** after release, independently confirming that the snapshot no longer blocked truncation.

The existing producer emits its metrics only after its `finally` rolls back and awaits executor close; the worker then emits its terminal message. Thus the observed single cleanup sequence is supported by code inspection and an independent SQLite effect. **These are not direct SQLite method-call counters.** A proposed raw admission run with begin/rollback/close counters was **not performed**, following the operator's stop instruction. No production counter instrumentation was installed.

This demonstrates held, bounded progress for the sampled stopped-reader interval and release after disconnect/completion. It does not exercise the full ten-minute job deadline, prove an absolute WAL bound independent of writer rate, or measure multi-client admission capacity. Those were not silently counted as passing.

## Resumption and ordinary readers

Raw sockets used `SO_RCVBUF=4096` (Linux reported 8192), sent an HTTP request and made **no `recv` calls during the stall**. Only afterward did resumption begin: at most 65,536 bytes per `recv`, followed by a 2 ms sleep. This remains a raw-socket proof, not a JavaScript-paced substitute. RST cases used `SO_LINGER` with a zero linger timeout.

| Coding | Paced worker body bytes, 1.3.14 / 1.4.2 | Paced read duration, 1.3.14 / 1.4.2 | Ordinary-reader completion, 1.3.14 / 1.4.2 |
| --- | ---: | ---: | ---: |
| identity | 52,943,466 / 52,943,466 | 42.69 / 49.31 s | 1.658 / 1.716 s |
| gzip | 8,766,768 / 8,766,767 | 9.29 / 9.51 s | 7.948 / 5.102 s |
| zstd | 8,547,326 / 8,547,328 | 7.08 / 7.41 s | 7.814 / 5.165 s |

All six ordinary-reader cases used POD-3946's unchanged Node client, exited zero, and decoded **52,943,466 bytes, 5,120 rows and 51 records**. Gzip achieved about 6.039× compression; zstd about 6.194×. Small encoded-length differences are expected between different transfer UUIDs; decoded size was identical.

Offline decoding of both fresh paced gzip captures verified 5,120 original snapshot payloads despite the ten concurrent writes, and exactly one `syncComplete`. The original paced identity capture was also decoded to 5,120 rows and one `syncComplete`. Fresh identity/zstd paced cases have raw captures, worker completion and cleanup evidence; their raw captures were **not separately decoded after the stop instruction**. Their ordinary-reader controls did decode the full fixture.

The host was heavily loaded and conditions changed between sequential cases. These durations establish successful completion, **not a controlled throughput regression or speedup claim**.

## Other findings and work not performed

- **Initial gzip timeout:** in the first sequential 1.3.14 run, following two identity transfers, gzip produced no meta/bytes and a fixture write timed out. That failure remains preserved. Fresh full-fixture gzip disconnect, resumption and ordinary-reader cases all worked on **both versions**. The coordinator classified the initial event as transient host load; this measurement establishes non-reproduction, not its precise cause. No gzip defect or 1.4-only regression was demonstrated, and no unrelated fix was made.
- **No additional Bun 1.4-specific breakage was observed in the executed endpoint cases.** This is limited to these measurements. No repository-wide compatibility result is claimed.
- **Bun 1.4.2 zstd was actually run:** the previously launched sequential runner completed disconnect, paced resumption and ordinary-reader cases before the stop message was processed. They are reported above. The coordinator acknowledged the timing correction; no further zstd run followed the stop.
- **Not performed:** raw multi-client admission and direct SQLite begin/rollback/close counters; ten-minute deadline expiry; delta measurements; compiled desktop/runtime checks; repository-wide tests or extensive pre-merge validation. The operator stopped additional work and reserved programme-wide testing for the end.

## Handoff and cleanup

All measurement processes exited. The `sync-gate` lease was released. Every created fixture database, WAL, SHM and fixture state directory was removed; evidence files remain. The runs enforced a 3 GiB disk floor and executed sequentially. No test gate was run after the stop instruction, and no green test-suite claim is made. The deliverable is the report and attached evidence; temporary measurement script changes were archived with the evidence and removed from the checkout. Stage: review. No merge.
