# POD-2056 — what the daemon-restart lane measured

The claim under test: *when the Podium daemon restarts while an opencode server
session is running, the session is picked back up automatically.*

`adopt()` is implemented and four conformance properties pin its contract
behaviour against the real driver. What had no lane was the integration — start
a real daemon with a real `opencode serve` behind it, kill the **daemon only**,
restart it, and watch the session come back. `tests/e2e/` had no way to express
that, because every lane there starts its daemon in-process and an in-process
daemon cannot die.

This records what building that lane and running it four times against a real
opencode 1.18.16 actually found.

---

## 1. The harness

Three files, in `tests/e2e/`:

| file | what it is |
|---|---|
| `daemon-process.ts` | the daemon as the OS runs it — real pid, real parent/child link to what it spawns, real SIGKILL available |
| `daemon-restart-harness.ts` | `startDaemonProcess()` → `crash()` / `stop()` / `restart()`, plus the child's captured log |
| `daemon-restart-adoption.e2e.test.ts` | the lane |

The harness self-check is **not** opt-in. A two-process harness that has quietly
stopped being able to start a daemon should fail loudly rather than skip, so it
runs unconditionally; only the half that needs a model credential is gated
behind `PODIUM_OPENCODE_LIVE=1`. That self-check is **green**: a real child
daemon boots, handshakes with a real server over a socket, appears in the
machine roster, and stops.

---

## 2. Finding: the daemon's version probe loses a race it should not be in

**Status: fixed by POD-2023, landing in their current round.**

`opencodeVersionDiagnostic()` probed the binary with a **15s** budget.
`opencode --version` forks a ~180MB single-file bundle. Measured on this
project's build host:

| context | timings |
|---|---|
| under vitest load | 15059ms (**ETIMEDOUT**), 11174ms, 14988ms |
| idle box | 18820ms, 9550ms, 12870ms, 14200ms |
| POD-2023 reviewer, same box | 22760ms, 11940ms, 26120ms |

Roughly **half of all probes exceeded the budget**, for a binary squarely inside
the supported range that answers `1.18.16` correctly when asked with patience.

### Why it mattered more than a flaky probe

A lost probe did not fail the spawn. It made `availableDriverIds()` omit
`opencode-server`, so `resolveRuntimeDriver()` fell back to a terminal driver and
`launchServerDriverSession()` returned "not mine" — and the session became a
**PTY session**, silently, despite an explicit per-spawn
`runtimeContract: 'opencode-server'` override.

What that looked like from outside, in order of when you meet it:

1. the session goes `live` — nothing looks wrong
2. the row reports `runtimeContract: true`, because the *terminal* driver was
   registered and the predicate answers honestly about the wrong thing
3. the first turn returns `{"outcome":"unverified","verificationWindowMs":4800}`
   — four steps past the cause, and it reads as a model problem
4. the only unambiguous signal is a **missing binding journal**
5. there *is* a log line, and it misdirects:
   `opencode is outside the server driver range`, `observedVersion: "(no output)"`
   — sending whoever greps it to inspect a perfectly good binary

The reviewer added two facts reproducing it: the verdict was **memoized
including its failure**, so one lost coin flip disabled the driver for the
daemon's whole lifetime; and `spawnSyncVersion()` discarded `result.error`, so
the ETIMEDOUT never reached the gate at all — `spawnSync` does not throw on
timeout, and `gateOpencodeVersion('')` took its unparseable-version arm.

POD-2023 has since raised the budget to 60s, split the verdict into
drivable / `unsupported` / `unprobeable`, stopped memoizing `unprobeable`, and
made an explicit server-driver request on an unprobeable machine a `spawnError`
rather than a PTY session.

### What the lane does about it

Asserts **binding-journal presence**, not `runtimeContract`, as its family test
— the journal is written by exactly one thing, so its presence is the fact,
whereas `runtimeContract` stays true straight through this failure. The failure
text also explicitly contradicts the misdirecting warn, because that warn is the
first thing anyone will grep.

---

## 3. Finding: nothing calls `adopt()` on daemon boot

**Status: open. This is the finding the issue existed to produce.**

The driver has `adopt()`. The host has `adopt()`. The conformance corpus
exercises `adopt()`. **No daemon code path calls it.**

`DaemonOpencodeRuntime` (`apps/daemon/src/runtime/opencode-driver.ts`) exposes
`launch()` and `has()` — and no adoption entry point. So on restart, a
server-family session follows the reattach path built for PTYs:

1. `handleReattach` finds no bridge — a fresh daemon holds nothing, and a
   server-family session never had a bridge to begin with
2. it falls into the durable-host branch, which looks for an abduco socket or a
   tmux session named for the session's durable label
3. there is no PTY, so there is neither
4. it sends `reattachFailed` — reason **`session not found`**

Meanwhile the `opencode serve` process is alive and healthy behind its
journalled endpoint, answering its health probe on the journalled secret, with
nothing bound to it.

So the user-visible behaviour today is: **restart the daemon and your opencode
session appears dead, while the agent it was running keeps running, orphaned.**

The lane fails at step 5 of 6 for this reason, and will keep failing until that
wiring exists. `adopt()` itself is not in doubt.

---

## 4. Finding: the daemon is silent when it is not in your process

**Status: worked around in the harness.**

`@podium/logger` ships with no sinks and `startDaemon` registers none. Every
in-process e2e is unaffected — its daemon logs into the same process that can
inspect it directly. A daemon in its own process writes **nothing at all**, so
the parent's only diagnostic is an empty string that reads like "the daemon had
nothing to say", which is a claim, and a wrong one.

`daemon-process.ts` now installs a console sink itself. Finding §2's decisive
evidence — the daemon's own words, verbatim — only became visible after this.

---

## 5. Also filed

**POD-2096** — `SuperagentService.dispose()` clears its turn reaper, but
`SessionRegistry.dispose()` never calls it, so the interval outlives
`store.close()` and throws `RangeError: Cannot use a closed database` on every
server shutdown. Reproduced on every run of this lane; vitest reports it as an
unhandled error and warns it "might cause false positive tests".

---

## How to run it

```
PODIUM_OPENCODE_LIVE=1 bun --bun node_modules/vitest/vitest.mjs run \
  --config vitest.config.ts tests/e2e/daemon-restart-adoption.e2e.test.ts
```

Without the flag the harness self-check still runs; the live half says it was
skipped, and now says why.
