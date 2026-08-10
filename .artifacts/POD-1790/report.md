# POD-1790 bootstrap cadence evidence

## Root cause

A cold feed socket was admitted and the server immediately began its mandatory initial-world delivery. Before that world arrived, `FeedSink.connected()` started the Replica fallback ladder; `PushedBootstrapSource` saw no parked world and called `requestFreshWorld()`, closing the brand-new socket and repeating the same bootstrap on its replacement.

A live 60-second pre-fix trace captured 2 WebSocket opens, 1 close, 2 hellos, and 2 `feedBootstrap` frames for one browser, with no rescope or resync request. Across the live server during that trace, bootstrap count rose by 23. The historical `ws.attach` metric was traced to terminal-session attachment, not browser peer admission, so its ratio to bootstrap count was not a socket count.

## Fix

- Mark every newly opened feed socket as owing one mandatory initial world, so a cold Replica walk waits for that in-flight world instead of replacing the socket.
- Retain a bounded per-principal latest-state world in `FeedServing`.
- Advance that positive-state world from scoped upsert/remove/evict batches, and invalidate it on rescope.
- Reuse only when its certified `throughSeq` equals the Authority cursor; a missed head movement always falls back to a full authoritative fold.
- Keep repeated attach idempotent and preserve the mandatory initial world and certified delta position.
- Split performance counters into actual `feedBootstrap.read`, cheap `feedBootstrap.reuse`, total servings, and attach/hello/version-change causes.

## Runtime evidence

The prescribed true input-event-to-visible-paint benchmark from POD-1784 was run against the isolated real server, daemon, PTY, web build, Firefox, and xterm from this branch:

- Before fix on the live instance: the benchmark could not begin sampling because `sessions.list` timed out after 10 seconds.
- Final branch, 60 samples: p50 47 ms, p90 105 ms, max 187 ms.
- Input-to-frame: p50 19 ms, p90 79 ms, max 144 ms.
- Frame-to-paint: p50 27 ms, p90 36 ms, max 79 ms.

The final cold lifecycle trace recorded exactly 1 WebSocket open, 0 closes, 1 hello, and 1 `feedBootstrap`. With that peer held open, an overlapping second real browser exercised `feedBootstrap.reuse`: 1.03 ms, while the two full reads in the isolated run were 24.54 ms and 72.68 ms.

Primary raw evidence: `typing-after-final.json`, `peer-lifecycle-before.json`, `peer-lifecycle-after-final.json`, `perf-current.json`, and `perf-after-final.json`.

## Verification

- Focused server feed suite: 13/13 passed.
- Focused client bootstrap/sink suite: 5/5 passed.
- Replica divergence matrix: 10/10 passed.
- `bun run typecheck`: 23/23 package tasks successful.
- `bun run test` was run twice. Relevant feed/client lanes pass, but the repository baseline gate is not green: a clean install stops first on 7 unrelated scripts audits; an earlier cache state reached server and found 4 unrelated stale characterizations with 4,140 tests passed and 1 skipped. Proposed POD-1810 tracks those baseline failures; none names or exercises the POD-1790 files.
