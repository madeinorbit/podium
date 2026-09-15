# POD-3931 — Bun WebSocket send/drain backpressure

Server-side only. Works with the installed mobile client (no capability change,
no acknowledgements). Keeps Bun's native server, the application protocol,
negotiated Zstd and the JSON fallback.

## What was wrong

Measured on Bun 1.3.14 with a client that stopped reading (probe in the
transport test's header):

| `send` result | Meaning | Old `OrderedClientSend` |
| --- | --- | --- |
| positive | written | ignored |
| `-1` | accepted into Bun's buffer; stop until `drain` | ignored, kept sending |
| `0` | NOT accepted, frame dropped | ignored — a reliable stream lost frames silently |

`drain` fires on every writable event that shrank Bun's buffer, not only when it
is empty. The old sender never subscribed to it. Its only pressure policy was
`bufferedAmount > 16 MB → terminate`, so a healthy phone reading a 50 MB
bootstrap at its own pace was cut off mid-world and reconnected in a loop, and
nothing was logged with a reason. `serveWorld()` also serialized every chunk
eagerly into the sender's FIFO before the publisher was connected.

The failure line the new sender emits (`client send stream failed`, with
`reason`, `label`, `compression`, buffered/queued/ready bytes, frame counts,
pauses, peaks, shared-budget bytes and active jobs) is what establishes the
actual cause on a future recording. Payloads and credentials are never logged.

## Pump states

One owner per socket (`OrderedClientSend`), two ordered stages:

```
queue  (admitted, application order; a sequence stays at the head until exhausted)
  │  prepare(): pull ≤ prepareAheadCount / prepareAheadBytes ahead; one Zstd job at a time
  ▼
ready  (encoded + compressed, application order)
  │  write(): send until -1 / high-water / turn budget
  ▼
socket
```

Waits are modelled separately:

- **`paused`** — waiting on the socket. Set on `-1`, or when `bufferedAmount` is
  already at the plane mark before a send. Cleared only by a native `drain`
  that leaves the buffer under the mark (a drain that flushed some bytes but
  leaves it above the mark counts as progress and keeps waiting). Nothing is
  written while paused; a `-1` frame is never resent; a `send()` or a finished
  compression job while paused lands in `ready` and waits.
- **`compressing` / `budgetWait`** — waiting on preparation. One native Zstd
  job per socket (so order is trivial), shared concurrency and byte budget
  across sockets (`BootstrapCompressionBudget`, unchanged, now with an
  `onRelease` hook). A full budget PAUSES a lazy sequence until a release; an
  input that alone exceeds the budget fails with `shared-memory-limit`.
- **turn budget** — `turnBudgetBytes` (4 MiB) of serialization + writes per
  event-loop turn, then `setImmediate`; a fast receiver cannot let one bootstrap
  monopolise the loop (measured in the transport test: a second client's
  round-trip stays under 500 ms during a 50 MB transfer).

Reentrancy: `pump()` is guarded; calls during a pass set `rerun`. The pass loops
while it makes progress. Drain, compression completion, budget release and the
yield all re-enter through `pump()`.

**Never send from inside the native `drain` callback.** Observed on Bun 1.3.14
over loopback with a reader that pauses 150 ms between bursts: a send made
synchronously inside `drain` that was itself buffered (`-1`) stayed in Bun's
buffer (about one frame, ~1 MB) with the kernel send buffer empty and no
further `drain` — the transfer wedged until the no-progress deadline. The same
pump resuming one macrotask later (`setImmediate`) completed every time. The
drain still counts as progress immediately; only the write is deferred.

Results: positive → advance; `-1` → advance then pause; `0` → reliable stream
fails `send-not-accepted` (lossy: dropped); throw → `send-error` (lossy:
dropped). Lossy admission is refused while paused or over the stream budget and
never terminates anything.

## Capacity ownership

| Bytes | Owner | Bound |
| --- | --- | --- |
| Bun's buffer | native | plane mark (16 MB) + at most one frame; Bun's `backpressureLimit` is set to mark + `WS_MAX_PAYLOAD_BYTES` so ordinary `-1` never becomes a `0` |
| immediate reliable frames (`send`) | pump `queue` | `maxQueuedBytes` (128 MiB) / 8192 frames → `application-queue-limit` (caller is synchronous, cannot wait) |
| sequence frames (bootstrap) | pump `ready` | `prepareAheadCount` (2) and `prepareAheadBytes` (8 MiB) — never the whole world |
| input owned by a Zstd job | shared budget | 256 MiB / 2 jobs across all sockets; counted until the native job settles, even after dispose |
| lossy frames | pump | stream budget (256 KB) incl. buffered + queued; refused while paused |

The retained world snapshot (`latestWorldByPrincipal`) is still proportional to
its size; the claim is bounded *additional* transfer buffering.

Failure reasons: `send-not-accepted`, `send-error`, `socket-closed`,
`application-queue-limit`, `shared-memory-limit`, `no-progress-timeout`,
`serialization-failed`, `frame-too-large`, `binary-unsupported`. The
no-progress deadline (`PODIUM_WS_NO_PROGRESS_MS`, default 60 s) is armed only
while reliable work is waiting on the socket or the budget; a positive/`-1`
send or any drain resets it. A long but moving bootstrap never times out.

Teardown: `dispose()` (socket close, failure) is idempotent — cancels the
timer, unsubscribes drain, unsubscribes the budget wait, releases every queued
and ready reservation once, settles every pending sequence once with a reason.
A late or repeated drain after dispose is a no-op.

## Snapshot → live ordering argument

`serveWorld()` captures the world at `throughSeq` (a stable array; the cache
replaces entries, never mutates the array it handed out), then in ONE
synchronous stretch:

1. offers the chunk generator to the peer's sink (`edge.publishSequenceTo` →
   `sink.sendSequence`) — the sequence now occupies the sink's order slot;
2. connects (or re-arms) the publisher at `throughSeq`;
3. retains the principal subscription.

Only then does it `await` the transfer. Every delta the publisher frames from
step 2 on is offered to the same sink through `send()` and waits behind the
sequence, so a change committed during a minutes-long transfer reaches the
client after the last chunk with `fromSeq === throughSeq`. The publisher's own
bounded queue (D9, `FEED_SEND_QUEUE_MAX_BYTES`, demotes to re-bootstrap) and the
sink's `maxQueuedBytes` bound the delta tail explicitly; nothing accumulates
without a limit. No store lease spans the wait: `withReadScope` is memoization
only (`read-scope.ts` header), the array is the retained world, not a cursor.

The admission slot stays held while the transfer runs, so a second `hello`
inside the window cannot start a second world; `detach` mid-transfer disposes
the sink, the sequence settles `socket-closed`, and the admission records it
without terminating anything twice. Peers without a lazy sink (in-process
fixtures, the oracle harness) are iterated eagerly, which is byte-for-byte the
old behaviour. Wire-1 peers keep their single legacy chunk.

## Tests

- `ordered-client-send.pump.test.ts` — scripted positive / `-1` / drain /
  positive; `0`; throw; late/repeated drain; close while paused; prepare bounds
  by count and bytes; later sends behind a sequence; turn yield; no-progress
  timeout armed only while stalled; queue limit; shared-budget wait. 16 of 17
  fail on the old sender.
- `ordered-client-send.test.ts` — the existing Zstd/fallback/ordering cases;
  two expectations changed from terminate to pause.
- `ordered-client-send.transport.test.ts` — real `Bun.serve` + the production
  `NativeGatewaySocket`, raw TCP client with a hand-written handshake and
  `socket.pause()` read throttling: 50 MB uncompressed and Zstd, uneven rows,
  stop/resume, never-resumes (`no-progress-timeout`), lossy pressure,
  two-client shared-budget exhaustion, fast-client latency during a slow 50 MB
  transfer. Each case prints peak socket bytes, peak application bytes and the
  shared budget separately (`[transport] …`).
- `feed-serving.transfer.test.ts` — real `FeedServing` over the real change
  log with a hand-pulled lazy peer: a commit inside the transfer window arrives
  after the last chunk, `fromSeq` equals the snapshot seq; an eager sibling is
  served at the new head meanwhile; detach mid-transfer.

## Measured (2026-09-15, Bun 1.3.14, loopback, plane mark 2 MiB in the test)

| Case | frames | bytes handed to socket | pauses | peak Bun buffer | peak app window | shared budget peak |
| --- | --- | --- | --- | --- | --- | --- |
| uncompressed 50 MB | 46 | 52,680,409 | 14 | 1,181,063 | 4,720,298 | — |
| Zstd 50 MB | 46 | 119,732 | 0 | 0 | 4,720,342 | — |
| stop / resume 50 MB | 46 | 52,680,409 | 15 | 1,181,063 | 4,720,298 | — |
| never resumes (400 ms deadline) | 13 | 14,609,896 | 4 | 1,121,904 | 4,720,342 | — |
| lossy pressure (200 offers) | 116 | 13,343,743 | 4 | 1,121,904 | 4,719,404 | 104 admitted / 96 refused |
| two clients, 6 MiB budget, Zstd | 10 + 10 | 26,006 each | 0 | 0 | 3,981,930 | 5,107,624 ≤ 6,291,456 |
| fast client during slow 50 MB | 46 | 52,680,409 | 20 | 1,069,124 | 4,720,270 | worst probe 17.1 ms over 39 probes |

Every reservation returned to zero after each case. Peak Bun buffer stays
under the mark plus one frame; the application window stays under the
prepare-ahead bound (8 MiB) regardless of world size.

## Not verified here

- Bun's `drain` cadence under TLS or through a reverse proxy (the probe and the
  tests are plain loopback TCP).
- The installed mobile build itself; the test client is a raw TCP reader.
