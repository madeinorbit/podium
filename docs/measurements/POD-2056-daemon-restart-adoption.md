# POD-2056 — what the daemon-restart lane measured

The claim under test: *when the Podium daemon restarts while an opencode server
session is running, the session is picked back up automatically.*

`adopt()` was implemented and four conformance properties pinned its contract
behaviour against the real driver. What had no lane was the integration — start
a real daemon with a real `opencode serve` behind it, kill the **daemon only**,
restart it, and watch the session come back. `tests/e2e/` had no way to express
that, because every lane there starts its daemon in-process and an in-process
daemon cannot die.

**The lane now passes.** Getting there took six live runs and turned up three
defects, two of them in code the lane had no business touching. This records
what it measured.

---

## 1. The harness

Three files, in `tests/e2e/`:

| file | what it is |
|---|---|
| `daemon-process.ts` | the daemon as the OS runs it — real pid, real parent/child link to what it spawns, real SIGKILL available |
| `daemon-restart-harness.ts` | `startDaemonProcess()` → `crash()` / `stop()` / `restart()`, plus the child's captured log |
| `daemon-restart-adoption.e2e.test.ts` | the lane |

`crash()` is SIGKILL and the signal is deliberately not configurable. A harness
that offered SIGTERM there would let a lane quietly test the graceful path while
its name still said "crash", and the difference between those two is the whole
subject: `close()` is a shutdown the daemon *participates in*, and recovery code
that has only ever seen the participating kind is recovery code nobody has
tested.

The harness self-check is **not** opt-in. A two-process harness that has quietly
stopped being able to start a daemon should fail loudly rather than skip, so it
runs unconditionally; only the half needing a model credential is gated behind
`PODIUM_OPENCODE_LIVE=1`.

---

## 2. What the passing run proves

Against a real server, a real daemon in its own process, and a real
`opencode serve` on opencode 1.18.16 — 84s of wall clock:

1. the session comes up on the **`opencode-server` driver** (binding journal
   present, mode **0600**, process key `podium-oc-<sessionId>`)
2. it takes a turn: `accepted`, `provenBy: protocol-ack`, and the reply renders
   in the session transcript the web UI reads
3. the daemon is **SIGKILLed** and confirmed gone
4. **`opencode serve` survives it** — still answering `/global/health` on the
   journalled `baseUrl` with the journalled secret, same pid alive. This is the
   half nothing had ever checked, and it is a precondition for everything below:
   if the agent died with its supervisor there would be nothing to adopt
5. the daemon restarts on the same state dir and machine id
6. **exactly one** `process/adopted` event arrives, at a **strictly higher
   observer generation** than anything seen before the crash
7. the journal still names the **same** process key, `baseUrl` and pid — so this
   was an adoption, not a relaunch wearing one's clothes. A relaunch would mint
   a new port, a new secret and a new pid, and lose the conversation while
   reporting success
8. the session is `live` again and still behind the contract
9. it takes **another turn** — `accepted`, `protocol-ack`, at a **higher turn
   epoch** — and the pre-crash reply is still in the transcript alongside the
   new one

---

## 3. Finding: the daemon's version probe lost a race it should not have been in

**Fixed by POD-2023.**

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
(The host runs at load average ~120 with five agents live on this epic, which is
the point: the budget was tight enough that ordinary contention crossed it.)

### Why it mattered more than a flaky probe

A lost probe did not fail the spawn. It made `availableDriverIds()` omit
`opencode-server`, so `resolveRuntimeDriver()` fell back to a terminal driver and
the session became a **PTY session** — silently, despite an explicit per-spawn
`runtimeContract: 'opencode-server'` override.

What that looked like from outside, in the order you meet it:

1. the session goes `live` — nothing looks wrong
2. the row reports `runtimeContract: true`, because the *terminal* driver was
   registered and the predicate is answering honestly about the wrong thing
3. the first turn returns `{"outcome":"unverified","verificationWindowMs":4800}`
   — four steps past the cause, and it reads as a model problem
4. the only unambiguous signal is a **missing binding journal**
5. there *is* a log line, and it misdirects:
   `opencode is outside the server driver range`, `observedVersion: "(no output)"`
   — sending whoever greps it to inspect a perfectly good binary

The POD-2023 reviewer added two facts while reproducing it: the verdict was
**memoized including its failure**, so one lost coin flip disabled the driver for
the daemon's whole lifetime (and a warm-up probe before the lane's real spawn
would have *poisoned* the run rather than primed it); and `spawnSyncVersion()`
discarded `result.error`, so the ETIMEDOUT never reached the gate at all —
`spawnSync` does not throw on timeout, and `gateOpencodeVersion('')` took its
unparseable-version arm.

POD-2023 raised the budget to 60s, split the verdict into drivable /
`unsupported` / `unprobeable`, stopped memoizing `unprobeable`, and made an
explicit server-driver request on an unprobeable machine a `spawnError` rather
than a PTY session.

### What the lane keeps from it

It asserts **binding-journal presence**, not `runtimeContract`, as its family
test — the journal is written by exactly one thing, whereas `runtimeContract`
stays true straight through this failure. Its failure text also explicitly
contradicts the misdirecting warn, because that warn is the first thing anyone
will grep.

---

## 4. Finding: nothing called `adopt()` on daemon boot

**Fixed by POD-2023 (`adoptServerDriverSession` / `adoptFromJournal`).**

The driver had `adopt()`. The host had `adopt()`. The conformance corpus
exercised `adopt()`. No daemon code path called it.

So on restart a server-family session followed the reattach path built for PTYs:
`handleReattach` found no bridge, fell into the durable-host branch, looked for
an abduco socket or tmux session named for the durable label, found neither —
there is no PTY — and answered `reattachFailed: session not found`, while the
`opencode serve` process stayed alive and healthy with nothing bound to it.

The user-visible behaviour was: **restart the daemon and your opencode session
appears dead, while the agent it was running keeps running, orphaned.**

This is the finding the issue existed to produce, and it is the one no unit test
could have produced: `adopt()` was correct in every isolated respect, and the
gap was that nobody called it.

---

## 5. Finding: the daemon is silent when it is not in your process

**Worked around in the harness.**

`@podium/logger` ships with no sinks and `startDaemon` registers none. Every
in-process e2e is unaffected — its daemon logs into the same process that can
inspect it directly. A daemon in its own process writes **nothing at all**, so
the parent's only diagnostic is an empty string that reads like "the daemon had
nothing to say", which is a claim, and a wrong one.

`daemon-process.ts` installs a console sink itself. §3's decisive evidence — the
daemon's own words, verbatim — only became visible after that.

---

## 6. Also filed

**POD-2096** — `SuperagentService.dispose()` clears its turn reaper, but
`SessionRegistry.dispose()` never calls it, so the interval outlives
`store.close()` and throws `RangeError: Cannot use a closed database` on server
shutdown. Reproduced on every run of this lane; vitest reports it as an
unhandled error and warns it "might cause false positive tests".

---

## How to run it

```
PODIUM_OPENCODE_LIVE=1 bun --bun node_modules/vitest/vitest.mjs run \
  --config vitest.config.ts tests/e2e/daemon-restart-adoption.e2e.test.ts
```

Without the flag the harness self-check still runs; the live half says it was
skipped, and says why.
