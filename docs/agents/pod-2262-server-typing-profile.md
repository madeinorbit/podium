# Server typing-stall profile

Profiled the live default instance on 2026-08-17 using the built-in server and daemon
event-loop attribution, cumulative task/SQL totals, and `perf.snapshot`. The repeatable
browser typing benchmark could not collect end-to-end samples because the live page never
exposed `New panel` before its 180-second timeout; that separately shippable failure is
tracked as POD-2266.

## Result

Typing is not stalling in the input handler. The coordinating server's single event loop is
being occupied by unrelated, synchronous full-session projection and publication work.

The primary hotspot is `sessionView.list`, which projects, authorizes, and wires the full
stored session corpus. At capture time the database held 1,889 sessions and 952 distinct
referenced issues. The live phase registry reported:

| Phase | Count | p50 | p90 | p99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `sessionView.list` | 1,337 | 486.9 ms | 653.3 ms | 951.4 ms | 4,534.2 ms |
| `sessionsBroadcast.total` | 1,527 | 1.6 ms | 69.0 ms | 608.2 ms | 954.6 ms |
| `feedPublish.total` | 14,853 | 0.02 ms | 1.3 ms | 17.0 ms | 246.6 ms |
| `feedBootstrap.total` | 21 | 137.0 ms | 253.2 ms | 1,056.1 ms | 1,056.1 ms |

The repeated bulk SQL visible during long stalls is the issue prefetch inside
`SessionView.project`: commonly two chunks returning 939 issue rows for one list pass.
SQLite accounts for only a minority of the pause. For example, an 8.0-second busy stall
contained 24 bulk-issue statements totaling 418 ms; the remaining time is predominantly
synchronous JS work over the session corpus. This matches the phase timer above.

The second hotspot is volatile-session publication. The built-in task profiler reported an
anonymous zero-delay callback with a 955 ms maximum; `SessionBroadcastCoordinator` schedules
its capture on `setTimeout(..., 0)`, and `sessionsBroadcast.total` has a matching 954.6 ms
maximum. This work also runs on the input-serving loop.

Daemon WebSocket handling is the dominant entry label, but the label is broader than PTY
output: it includes daemon-originated agent relay and lifecycle operations. Cumulative task
totals at 14:47 local were:

| Task | Count | Total | Max |
| --- | ---: | ---: | ---: |
| `ws.message.daemon` | 156,503 | 375.7 s | 3,663 ms |
| `setTimeout(0) <anonymous>` | 1,568 | 70.2 s | 955 ms |
| `ws.message.client` | 10,407 | 27.7 s | 1,067 ms |
| `ws.client.input` | 5,110 | 13.4 s | 127 ms |

`ws.client.input` averages roughly 2.6 ms per call. The user-visible pause therefore comes
from a key arriving while the loop is occupied, not from routinely expensive input routing.

## Measured windows

From 14:33:12 to 14:38:27 local, the server recorded 97 stalls totaling 39.1 seconds:

- p50 174 ms, p90 899 ms, p99 2,535 ms, maximum 2,794 ms
- 87 CPU-busy, 9 mixed, 1 scheduler-starved
- 34 at least 250 ms, 26 at least 500 ms, 8 at least one second
- 85 of 97 named daemon WebSocket work as the largest attributed task
- 15 of the 26 stalls over 500 ms combined low task coverage with the repeated bulk issue
  projection, while five were directly covered by a long daemon-frame handler and five by
  a zero-delay callback

Over the exact same interval, the daemon recorded 34 stalls totaling 4.7 seconds, with p90
185 ms and maximum 347 ms. This rules out the daemon and host scheduler as the main source of
the much larger pauses.

An ambient follow-up from 14:43:00 to 14:47:28 was worse: 123 server stalls totaling 98.2
seconds, p50 443 ms, p90 1,521 ms, maximum 7,974 ms, with 113 classified CPU-busy. The worst
stall spent only 418 ms in its bulk issue SQL, again leaving most of eight seconds in the
synchronous projection/application layer.

## Code paths implicated

1. `SessionView.project` builds a full reader-scoped session world. It primes issue/grant
   memos, then filters and wires every candidate synchronously. At live corpus size, a single
   pass is already a visible stall.
2. Issue/message eligibility and other orchestration paths still call `listSessions()` for
   set membership or a single lookup. Issue mutations are common agent activity and can
   enter through `ws.message.daemon` via the agent relay, so their downstream full-list work
   is charged to that broad task label.
3. `SessionBroadcastCoordinator` and volatile capture coalesce work onto a zero-delay timer,
   but the callback itself is not time-sliced and can occupy the loop for almost a second.
4. `ws.message.daemon` is not split by decoded frame type, so it cannot yet rank terminal
   frames versus relay/lifecycle frames. Splitting attribution after decode would make the
   remaining daemon-frame cost actionable.

## Recommended fix order

1. Remove full `sessionView.list` projections from mutation and eligibility paths. Use the
   existing narrow `sessionById` / `listSessionsForIssue` shapes or an internal lightweight
   session index, and build full wire projections only for consumers that actually need the
   world.
2. Bound or slice volatile-session capture/publication so one zero-delay callback cannot run
   hundreds of milliseconds uninterrupted.
3. Attribute daemon messages by decoded frame type and add caller labels for full session
   list projections; this will expose the residual cost after the first two fixes.

## Limitations

Linux `perf` could not attach because the host has `kernel.perf_event_paranoid=4`; changing a
host-wide security control was not warranted for this diagnostic. The repository's built-in
instrumentation was sufficient to isolate the dominant phases. No runtime code was changed
and no test lane was run; this deliverable is profiling evidence only.
