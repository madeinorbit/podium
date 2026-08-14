# POD-2056 — what the daemon-restart lane measured

The claim under test: *when the Podium daemon restarts while an opencode server
session is running, the session is picked back up automatically.*

`adopt()` was implemented and four conformance properties pinned its contract
behaviour against the real driver. What had no lane was the integration — start
a real daemon with a real `opencode serve` behind it, kill the **daemon only**,
restart it, and watch the session come back. `tests/e2e/` had no way to express
that, because every lane there starts its daemon in-process and an in-process
daemon cannot die.

**The lane now passes** — its assertions do. The *process* still exits `1` on a
live run because of POD-2096, which is not this lane's bug but is this lane's
problem; §6 says exactly what that means before anyone wires it into a gate.
Getting here took six live runs and turned up three defects, two of them in code
the lane had no business touching. This records what it measured.

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
7. that new generation carries **exactly one bootstrap snapshot and zero
   retroactive live edges** — the reattach contract's own words. Measured: the
   rebound generation holds one event, the adoption, tagged `bootstrap`; the ten
   pre-crash events all sit at the old generation tagged `live`. No transcript
   item and no turn event is republished as live, which is the half that would
   otherwise wake a parent and notify a human for something that already happened
8. the journal names the **same pid (still alive), the same `baseUrl` and the
   same secret**, at a **higher binding version** — so this was an adoption, not
   a relaunch wearing one's clothes. A relaunch mints a new port, a new secret
   and a new pid, and would lose the conversation while reporting success
9. the session is `live` again and still behind the contract
10. it takes **another turn** — `accepted`, `protocol-ack`, at a **higher turn
    epoch** — and the pre-crash reply is still in the transcript alongside the
    new one

### What the process-key check was, and why it is gone

The first version of step 8 compared `process.key` across the restart. That check
could not fail. `opencodeScopeLabel` is `` `podium-oc-${sessionId}` `` — a pure
function of the session id — so it returns the same string for an adoption, a
relaunch, a re-spawn, and a driver that bound the wrong process entirely. It read
like the load-bearing identity check and carried no information. The format pin
before the crash is its one honest use and it stays; across the restart the pid,
the port, the secret and the binding version do the work.

### What this lane still does not cover

**The gap-history fold.** `reattachment-design.md` also asks that a reattach
"reconcile all gap history into one newer bootstrap snapshot". This lane cannot
exercise that half, and the census says why: after the restart the driver's
in-memory log is new, so its bootstrap snapshot contains only the adoption. The
pre-crash conversation survives here because the **server** never went down and
already held it — not because the driver replayed it. A lane that restarted the
server too, or that let the agent speak while the daemon was dead, would have real
gap history to fold. The zero-retroactive-live-edges assertion above is therefore a
guard against a regression this scenario cannot currently produce; it is written
so that it will catch one if the fold ever starts replaying history as live.

**Its red is verified for the snapshot half.** Forcing `bootstrapUntil = 0` in the
driver's `events()` — so the replay comes through tagged `live` instead of
`bootstrap` — fails the lane at exactly the new assertion, with the message written
for it (`the rebind produced no bootstrap-provenance events at all, so the session
was restored without a snapshot to restore it from`), while steps 1-4 still pass.
The retroactive-live half has no such perturbation available for the reason in the
previous paragraph, and that is stated here rather than left to look verified.

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
than a PTY session. It later collapsed every copy of that number into one
exported `OPENCODE_VERSION_PROBE_TIMEOUT_MS`.

**This lane had already drifted from it**, which is the argument for that
constant in miniature: it carried a private 90s budget for its own probe and a
hand-copied `DAEMON_VERSION_PROBE_BUDGET_MS = 15_000` to compare against. The
second was stale the moment the daemon moved to 60s, and it was stale *inside the
failure message written to stop someone inspecting a perfectly good binary* — the
one place a wrong number costs the most. Both are now the shared import.

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

> **This lane exits non-zero until POD-2096 lands, and "the lane passes" above
> means its assertions pass.** vitest counts those unhandled errors and exits `1`
> even when every test is green — `Test Files 1 passed / Tests 2 passed | 1 skipped
> / Errors 1-3`, exit `1`. Without `PODIUM_OPENCODE_LIVE=1` the same file exits `0`,
> because the self-check never creates the session whose turn reaper is armed.
> The practical consequence: `bun run test:e2e` collects this file, so anyone who
> wires the live lane into a gate before POD-2096 is fixed turns that gate red for
> a reason that has nothing to do with adoption. Read the assertion counts, not the
> exit code, until then.

---

## How to run it

```
PODIUM_OPENCODE_LIVE=1 bun --bun node_modules/vitest/vitest.mjs run \
  --config vitest.config.ts tests/e2e/daemon-restart-adoption.e2e.test.ts
```

Without the flag the harness self-check still runs; the live half says it was
skipped, and says why.

That command is the direct one, for iterating. It does **not** take the shared
`test:heavy` lease, and this is now the heaviest lane in `tests/e2e/` — on a
contended host prefer the repo lane, `bun run test:e2e`, which goes through
`scripts/test-heavy.ts` and holds the lease for you. Expect exit `1` from POD-2096
either way (see §6).
