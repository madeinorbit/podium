# PTY transport measurement

Status: implementation specification for `POD-2957` (2026-08-27)

## 1. Outcome

The binary PTY migration has reproducible before/after evidence for representation size, codec CPU,
allocation pressure, throughput, replay/fan-out behavior, and user-visible input-to-paint latency.
Measurement catches regressions and guides later tuning; it does not require an invented percentage
speedup to justify the correctness and architectural change.

This issue may build and capture its baseline in parallel with terminal byte correctness. Its final
comparison waits for client output, daemon output, and binary input to integrate.

## 2. Required signals

Capture:

- raw payload bytes, base64 payload bytes, serialized JSON bytes, binary-envelope bytes, and actual
  compressed WebSocket bytes where the runtime exposes them;
- encode/decode elapsed time and operation count at daemon, server, and client boundaries;
- allocation or retained-heap proxy suitable for stable comparison on this runtime;
- output throughput and server cost with one and four viewers;
- replay storage and reconnect delivery cost;
- single-key and large-paste input-to-paint distributions, including p50 and p95.

The exact 25% reduction applies to raw bytes versus their base64 representation, not necessarily to
compressed wire bytes. Report both rather than presenting the theoretical ratio as measured network
savings.

## 3. Scenario matrix

The reproducible harness covers:

1. Payload sizes representing keystrokes plus 4 KiB, 16 KiB, 64 KiB, and 1 MiB streams.
2. ASCII, Unicode, escape-heavy terminal output, and code points split across frames.
3. All-in-one and real remote-daemon process topologies.
4. One attached viewer and four simultaneous viewers.
5. Live output and reconnect/replay delivery.
6. Binary-capable peers and every supported mixed-version direction/fallback.
7. Current compression thresholds enabled.
8. Single-key input and a large bracketed paste.
9. Existing backpressure behavior under a deliberately slow client.

Use hermetic codec and integration harnesses for the full matrix. Drive one smallest real browser
terminal interaction to establish the browser WebSocket -> `ArrayBuffer` -> xterm -> paint boundary;
do not browser-drive every matrix cell.

## 4. Observability contract

Production transport paths expose low-cardinality counters for:

- capability negotiated per plane/direction;
- frames and payload bytes by `client|daemon`, `input|output`, `binary|base64`;
- classified binary parsing/protocol failures;
- cheap encode/decode duration histograms where they do not distort the hot path.

No per-frame logs, session ids, application-version labels, or unbounded dimensions. The implementing
transport issues own their production counters; this issue owns the harness, baseline/final reports,
and interpretation.

## 5. Acceptance policy

Hard requirements:

- semantic parity across live, replay, resume, mixed-version, Unicode, and input-attribution cases;
- no unbounded memory growth or backpressure regression;
- no statistically meaningful user-visible latency regression;
- measurements are run from named commits on the same host/runtime configuration and report their
  sample count and variability;
- failures and unsupported measurements are stated, not silently omitted.

The project does not set a headline CPU or latency improvement threshold before seeing data. If a
material regression appears, stop integration and identify it. Otherwise record the observed gains,
neutral results, and costs, and use them to decide only later tuning work.

## 6. Durable evidence

The benchmark/harness belongs in the repository under a dedicated script or performance lane invoked
through a package script. Machine-specific baseline and final reports are issue artifacts, not
committed golden numbers. The final report names the base and candidate SHAs, commands, environment,
and raw result files.

## 7. Non-goals

This issue does not tune scheduler windows, compression thresholds, replay size, or fallback lifetime.
Any such change is separately justified by the measurements and separately tracked.
