# The four unattributed boundary failures, attributed

POD-3380. Follow-up to POD-3368, which grouped `@podium/server:test:boundary`'s failures by cause
and could pin 13 of its 17 causes to an introducing commit. This report closes the remaining four
(causes 12–15), each by `git bisect`, and corrects POD-3368's cause-14 diagnosis.

## What was run, and against what

| | |
|---|---|
| Lane | `apps/server` → `vitest.boundary.config.ts` (manifest shard `boundary`) |
| Measured HEAD | `f48768e06`, on `issue/3380-four-boundary-failures-lack-attribution` |
| `PODIUM_TEST_WORKERS` | **SET, to `1`** — inherited from the session environment, not exported by me |
| Files collected | **119 of 119** named in `test-shards.json` — nothing was excluded |
| Before this commit | 57 failed, 2300 passed, 1 skipped (2358) |
| After this commit | 55 failed, 2302 passed, 1 skipped (2358) |
| Bisect worktree | a detached checkout with its own `bun install`, one test per run |

## The answer table

| # | Test | Introducing commit | Ancestor of `origin/dev/mw` | Wrong thing |
|---|---|---|---|---|
| 12 | `relay-agent-relay` "routes a capability-scoped re-probe to the selected online machine" | `589512488`, 2026-08-25 — **the commit that added the test** | yes | test — **fixed here** |
| 13 | `relay-agent-relay` "allows a same-issue child spawn and bounded await through the relay (#475)" | `6fe82c4d3` POD-2646, 2026-08-23 | yes | test — **fixed here** |
| 14 | `relay.test` "hands a live busy Grok ledger send to exit recovery and the next bind" | `1a4664665` POD-3044, 2026-08-28 | yes | test |
| 15 | `messages/cutover` "delivers an issue-addressed send to the live agent and threads its reply back" | `6a41d3516` POD-2116, 2026-08-24 | yes | test |

`589512488` is titled `fix(harness): publish in-flight inventory probes`.

**All four are stale tests. No production defect was found, and the escalation condition the
coordinator set for cause 14 did not trigger.** Every attribution below is a bisect result, not a
reading of the code.

## Cause 14 — the suspected hang is not a hang, and not `resurrectSession`

This was the coordinator's priority, on the hypothesis that `resurrectSession` returns a
`pendingResurrections` entry that never settles — a wake that hangs forever with no error.

**That is not what this test does. It never calls `resurrectSession` at all.** POD-3368 quoted
`relay.test.ts:~4406` and the `await expect(reg.modules.issueSessionLifecycle.resurrectSession(…))`
line; both belong to the NEXT test in the file, `'resumes a Grok row admitted just before its child
exit reaches the server'` (line 4282). Vitest's timeout stack frame pointed into that neighbour, and
the diagnosis followed the stack rather than the test body. Instrumenting the failing test with
markers showed it never reaches any of its three `vi.waitFor` calls:

```
MARK 0 test-entry
MARK 1 pre-dispatch          ← last marker printed
     × hands a live busy Grok ledger send to exit recovery and the next bind 20007ms
```

It blocks at `await dispatchSessionCommand(…, 'sendText', …)` — line 4162, the first `await` in the
test.

**The block is bounded and deliberate.** `sendHandler` → `substrateSend` → `mailSend` →
`mailbox.sendAndConfirm` → `blockForDelivery`, which for `urgency: 'next-turn'` waits up to
`NEXT_TURN_DELIVERY_BUDGET_MS = 25_000` for the row to leave `queued`, then returns the honest
`accepted`. 25s simply exceeds vitest's 20s `testTimeout`, so the lane reports a timeout where the
real event is an assertion failure. Re-running with `--testTimeout=60000` proves it:

```
     × hands a live busy Grok ledger send to exit recovery and the next bind 25151ms
AssertionError: expected { ok: true, queued: true, …(2) } to deeply equal { … }
-   "disposition": "queued",
+   "disposition": "accepted",
```

**Bisected to `1a4664665` (POD-3044, "Fix contract send refusals", 2026-08-28)**, which selects the
delivery mode from the target session's contract binding instead of pinning `immediate`. The comment
that commit DELETED says what it was doing:

```
-    // ... `immediate` is the delivery mode, set
-    // by the server: ... See MailDeliveryMode for why the chat path
-    // needs it (POD-379 pins `disposition: 'queued'`; blocking would say
-    // `accepted`).
```

The test's session binds with `runtimeContract: true`, so from that commit on it takes the `confirm`
path and gets `accepted`. `git bisect` over 1432 first-parent commits confirms it: green at
`f030847888` (392ms), red at `1a4664665` (20s timeout). The test passed at its own introducing
commit `4be9b92c1` (2026-08-28) and broke the same day.

**The unhandled rejection POD-3368 attributed to this test is explained by the same fact and needs no
separate fix.** `blockForDelivery` polls `getMessage` every tick for 25s; vitest kills the test at
20s and the `finally` closes the store, so the last five seconds of polling hit
`RangeError: Cannot use a closed database`. It is the blocking send outliving the test, not abandoned
resurrection work.

**Verdict: TEST.** The product behaviour is intended, bounded, and documented. Not fixed here — see
"What is left" below.

## Cause 15 — a submit retry, not a duplicate delivery

Also a 25s block, for the same `NEXT_TURN_DELIVERY_BUDGET_MS` reason, but a DIFFERENT root: this
test's `messages.send` has always ridden the confirming path, so the block is not new. What is new is
what happens during it. With the timeout raised:

```
AssertionError: expected [ { …(2) }, { …(2) }, { …(2) }, …(1) ] to have a length of 1 but got 4
 ❯ cutover.test.ts:664   expect(frames).toHaveLength(1)
```

The test's own comment reads "a second would mean a duplicate delivery". **It would not.** Printing
the four frames shows one body and three bare submits (`ESC` written out, bracketed paste):

```
{ "o": "controller", "d": "ESC[200~please confirm you got this ESC[201~" }
{ "o": "controller", "d": "\r" }
{ "o": "controller", "d": "\r" }
{ "o": "controller", "d": "\r" }
```

**Bisected to `6a41d3516` (POD-2116, "fix(sessions): retain unconfirmed prompts for recovery",
2026-08-24)**, which changed `SessionInbox.drain` from remove-on-write to retain-and-retry:
"Unconfirmed → the row stays durable and queued, and ordinary rows retry with backoff." The fixture
has no agent to echo the turn back into the transcript, so nothing ever witnesses the submit and the
drain re-presses Enter until its deadline. A real harness echoes, confirms, and no retry occurs. The
body is pasted once either way.

**Verdict: TEST.** Its dark tail is clean: replacing the frame count with a body-frame count makes
the rest of the test — the reply over the relay, the threading onto the original, the ack asserted by
identity — pass in full. Nothing was hiding behind it.

## Cause 12 — an assertion that has never once run green

`589512488` added this test on 2026-08-25 **and it failed on that same commit**, with the same error
it gives today. Bisect could not find an introducing change because there is none: it was born red.
This is the second instance of POD-3368's cause-6 shape in this lane.

The fixture seeds its two machine rows with `ownerUserId: null`. `visibleMachinesFor` →
`machinesForPrincipal` filters on `canSeeMachine`, so neither row is visible to the resolved
principal and `machines.reprobe` refuses with `no visible machine with id 'm1'`.

**What it darkened is the assertion the commit was written for.** The line after the failing one is

```ts
expect(sent).toContainEqual({ type: 'inventoryRequest' })
```

— i.e. that a re-probe actually publishes an in-flight inventory probe to the daemon, which is that
commit's entire subject. It has never executed. **It passes** once the rows carry an owner, so the
code is correct and only the fixture was wrong.

**Verdict: TEST. Fixed here** — both rows get `FIRST_ADMIN_USER_ID`, as every production machine row
carries an owner.

## Cause 13 — the fixture's host machine has no daemon

`6fe82c4d3` (POD-2646) stamps issue worktrees with the machine that hosts them. Spawn placement now
resolves to the STAMPED machine, which for this fixture's injected store is the store's own
`hostMachineId` — a fresh uuid, and not the `m1` row the fixture attaches its relay daemon to.
`placementDecision` reads `machines.hasDaemon(machineId)`, finds none, and refuses:

```
{"ok":false,"error":"machine 9329a223-9f88-478c-a52f-46611a09e33c is not reachable right now"}
```

POD-3368 reported that attaching a daemon for `registry.sessionStore.hostMachineId` "does NOT fix it —
the test then hangs instead". **It does fix it.** The reported hang was the cause-12 failure still
present in the same file; with both fixture gaps closed the file runs **34 passed (34)**.

One caveat, worth recording because it is the trap: attaching that daemon in `beforeEach` fixes this
test and breaks a neighbour — a third live machine changes the fleet projection that "relays the
read-only multi-machine quota summary used by the panel" asserts on. The attach belongs inside the
one test, and the fix here says so in a comment.

**Verdict: TEST. Fixed here.**

## The gate: a name set, not a count

Both arms are the full 119-file lane at `f48768e06`, `PODIUM_TEST_WORKERS=1`, machine-readable
failure lists differenced on test NAMES.

```
before: 57   after: 55

ONLY ON AFTER (newly failing)
  (none)

ONLY ON BEFORE (fixed)
  - src/relay-agent-relay.test.ts >> server agent relay handler (P1b) allows a same-issue child spawn and bounded await through the relay (#475)
  - src/relay-agent-relay.test.ts >> server agent relay handler (P1b) machines enumeration routes a capability-scoped re-probe to the selected online machine
```

Nothing else moved in either direction.

## What changed in this commit

`apps/server/src/relay-agent-relay.test.ts`, fixture only — no assertion was modified:

- the two seeded machine rows carry `FIRST_ADMIN_USER_ID` instead of `ownerUserId: null` (cause 12);
- the child-spawn test attaches a daemon for the store's own host machine (cause 13).

## What is left

Causes 14 and 15 are diagnosed and attributed but NOT fixed, because neither is a one-line fixture
edit and both would modify a pinned assertion:

- **14** needs `disposition: 'accepted'` — but the test would then take 25 seconds of real time in
  the lane, so the right fix is probably to thread the fixture's clock/sleep into the send rather
  than to change the number. `sendAndConfirm` already accepts `pollMs` / `sleep` / `now`.
- **15** needs the frame assertion to count body frames rather than all frames, and its comment
  rewritten: extra frames are submit retries, not duplicate deliveries. Same 25s cost applies.

Both are filed as sub-issues under this issue with this diagnosis in their briefs.

One observation for the coordinator, not a defect claim: `1a4664665` means a `sessions.sendText` to a
BUSY contract session now blocks its caller for up to 25 seconds before answering `accepted`. That is
the documented next-turn budget doing what it was designed to do, and the message is durably captured
throughout — but it is a user-facing latency change to the chat send path that the commit's own tests
did not cover, and it is worth someone confirming the web client does not sit on that promise.
