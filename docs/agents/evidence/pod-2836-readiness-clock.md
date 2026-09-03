# POD-2836 — the composer-readiness clock, measured on a real send

The fix moves *when* the composer-readiness window starts. It does not change
how long the window is. This is the measurement that says so, taken on a real
`claude-code` CLI in a real PTY rather than only under fake timers.

## The rig

An isolated Podium instance `PODIUM_INSTANCE=lat2836` (state `/tmp/pod-2836`,
ports 19867/46867/46868, loopback only), server and daemon split and detached
under Bun — the topology a real install runs, re-cut from
`docs/evidence/pod-2245/op-up.sh`. Code under test is the issue worktree itself,
so an arm swap is one file plus a server restart; the server stamps
`v=dev+a79cbba-dirty` on every log line, i.e. the epic tip `a79cbba2b` with the
one-file change.

Sessions are created over tRPC (`sessions.create`, cwd = a scratch git repo),
not through the UI. Each rep gets a **fresh** session, because the first chat
send after a bind is exactly the send under test: `inputReadySessions` is empty
until a transcript-confirmed turn settles, so send #1 is the one that goes
through the readiness queue.

**What is being timed.** The clock starts at the `sessions.sendText` tRPC call
and stops at the *user turn the CLI writes into its own transcript*, read back
through `sessions.read`. That turn is the product's own witness that the prompt
arrived — the same signal the drain's `confirm()` watches — so the number is
delivery, not a proxy for it. Reported as `turn.ts − send`, which excludes the
poller's own 20ms granularity.

Both arms are byte-identical apart from `apps/server/src/modules/sessions/inbox.ts`;
the control arm is `git show HEAD:…/inbox.ts` restored over the working tree, so
`git diff --stat` for it is empty.

## The two cases, both arms

`PODIUM_TEST_WORKERS` is irrelevant here (no vitest); the numbers are seconds.

### A bound, idle session — 60s live before the send

This is the reported bug: a session that has been sitting ready pays the full
window on its first chat send.

| rep | before (epic tip) | after (fix) |
| --- | --- | --- |
| 1 | 6.585 | 0.417 |
| 2 | 6.958 | 0.464 |
| 3 | 6.497 | 0.422 |

~6.7s → ~0.43s. The before column reproduces POD-2828's 6.3s measurement.

### A send that arrives AT the bind — the composer genuinely unproven

Sent as soon as the row reports `live`, within a poll of the bind. This is the
case the window exists for, and the case a "just make it faster" fix would have
broken.

| rep | before (epic tip) | after (fix) |
| --- | --- | --- |
| 1 | 3.401 | 3.529 |
| 2 | 2.799 | 2.795 |

Unchanged. The wait is still there and still spent. (It settles under the 6s
ceiling in both arms because a booting CLI *paints*, so the quiet heuristic —
`READY_QUIET_MS` after fresh output — fires first. That heuristic is untouched;
it is why the ceiling is a ceiling and not the normal path.)

Read together, the two tables are the whole claim: the window did not move, its
zero did.

## Why the clock was wrong

`liveAtMs` was stamped in the drain's first tick, so every term in
`readyForInput` measured "how long since somebody asked us to type" rather than
"how long has this CLI had to put a composer up". An idle Claude session paints
nothing, so the quiet branch never fires and delivery always fell through to
`now - liveAtMs >= READY_MAX_MS` — 6s counted from the send, on every first send
after a bind, forever.

`READY_MAX_MS` is deliberately unchanged at 6s. Shortening it would trade this
latency bug for the silent loss it exists to prevent (POD-2116: bytes typed into
an unmounted composer are accepted by the pty and dropped by the app), which is
why the second table above is evidence and not a footnote.

## What already knew the bind time

Nothing recorded the moment, but the bind was already **announced** to the
object that needed it: `daemon-lifecycle.ts`'s `bind` case calls
`SessionInbox.markSessionBound`, which existed to clear the readiness marker for
the new CLI. It now also stamps the moment, in a `WeakMap<Session, number>`
beside the `WeakSet` it already kept. No new durable field: the fact only matters
while the process it describes is running, and a persisted copy would outlive it.

An unwitnessed bind — a live row rehydrated at server boot, before its daemon
reattaches — leaves the clock where it was. Unknown reads as unproven, never as
long-ago.

## Unit coverage

`apps/server/src/modules/sessions/inbox.test.ts`, describe
"the composer-readiness clock runs from the bind [POD-2836]". Four tests, each
pinned by its own mutation rather than by inspection:

| mutation | tests killed |
| --- | --- |
| `READY_MAX_MS` 6000 → 500 (the shortening that was forbidden) | 3 |
| unknown bind reads as long-ago (`boundAt ?? 0`) | 1 |
| a rebind does not restamp the clock | 1 |
| the fix itself reverted (control arm, rig kept) | 1 |

Gates: `bun run typecheck` plain — 25/25 successful. Per-file, with
`PODIUM_TEST_WORKERS` unset via `env -u`: `inbox.test.ts` +
`oracle-idempotency.test.ts` 98 passed (98).

## The numbers raised to tolerate the bug, brought back down

`oracle-idempotency.test.ts` carried `FIRST_SEND_AFTER_BIND_MS = 10_000` and
three 30-second per-test bounds, raised for no reason but this latency. All four
are gone: the constant is back to the helper's own 2s default, stated explicitly
only so a future regression in the clock fails here rather than quietly getting
slow again, and the three `}, 30_000)` bounds are removed.

They come down by a change of SETUP, not by a looser assertion. The fixture's
registry now takes a movable clock (`makeOracle({ now })`, additive and opt-in —
every other caller still gets `Date.now`), and `goIdle` advances it by 60s after
announcing the bind. The drain still polls on real timers; only the elapsed time
it asks the registry for moves. So the send those three make is the send they
were always about — a dedup replay into a session whose composer has
demonstrably had its window — rather than a measurement of how long a fresh CLI
takes to mount one.

| test | before | after |
| --- | --- | --- |
| `resumeAndSend` dedupes its replay | 2108ms | 320ms |
| `sendText` dedupes its replay | 2056ms | 351ms |
| a replayed send does not double-type | 2075ms | 260ms |

Both halves are load-bearing, each pinned by its own mutation:

| mutation | result |
| --- | --- |
| `BIND_AGED_BY_MS` 60_000 → 0 (stop ageing the bind) | all 3 time out |
| the fix reverted, tightened rig kept | all 3 time out |

The second row is the honest statement of the dependency: the tightened bound is
affordable only because the clock is anchored to the bind. None of the three
still needs a raised bound.

`relay.outbox.test.ts` is 5 failed / 12 on BOTH arms — identical failure names,
pre-existing on the epic tip (the confirmed-turn contract, POD-2831/POD-2837
territory). The eleven services-lane `oracle-*` failures are likewise 34 failed
/ 180 passed on both arms.
