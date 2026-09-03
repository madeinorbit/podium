# POD-3043 — Claude SDK interrupt receipt

Recorded 2026-08-28 (CEST). Pin `14de478a8`, based on epic tip `85cb15f3c`.

Scope: the `claude-sdk` interrupt path only. This is a **bring-up fix, not a
release-bar cell** — per Decision 29 the bar is the shipping drivers, and for
Claude that is `claude-pty`, which is untouched here.

## Verdict

**A3 / claude-sdk: PARTIAL.** Scored at what the evidence supports, not at what
the fix intends.

| clause of the A3 criterion | status | on what evidence |
|---|---|---|
| turn stops | PROVEN at the unit boundary | the runtime closes the turn as interrupted and the state leaves `working` |
| transcript shows interrupt | **PROVEN PRODUCED, NOT PROVEN SURVIVING** | the record is emitted, worded correctly, and exactly-once — but has never been observed coming back out of a real instance's transcript read |
| refused interrupt says why | PROVEN at the unit boundary | the provider's own message is carried into the record |

**There was NO live positive control, because no live turn was driven.** This
issue's brief forbade any provider drive; the epic bar requires one. That
contradiction was resolved by the coordinator as Decision (b): land as a
bring-up fix scored PARTIAL, and hand the live A3 drive to **POD-3048**, which
inherits this pin and this clause list.

Do not promote this row to PASS on the strength of the mutants below. They are
a unit-boundary control. They are not a live arm, and the second clause is
specifically the one a live drive could still falsify.

## What was actually wrong

Not a missing marker on top of a working interrupt. **The interrupt had no read
path at all**, at three hops:

- `apps/daemon/src/claude-sdk-host.ts` called the SDK as
  `void q.interrupt().catch(() => {})`. A provider that **refused** the
  interrupt and one that honoured it were observably identical: nothing.
- `apps/daemon/src/claude-sdk-protocol.ts` had no reverse direction for
  interrupts at all, so no verdict could reach the daemon even if the host had
  held one.
- The runtime's `interrupt()` pushed no event, and `interrupt()` on an idle
  session returned silently — reading, to the operator, as a stop that had
  worked on a session that had never been running.

This is the mechanism behind the standing brief's 2026-08-27 05:20 correction.
`after.ok` could not distinguish "stopped because of the interrupt" from "ended
while the interrupt was refused" — **because the product could not distinguish
them either.** The probe's weakness was a faithful reflection of a real one.

## The fix

An `interrupt-ack` frame carries the provider's own verdict back, correlated by
request id. The host awaits `query.interrupt()` and reports acceptance, refusal
with the provider's message, a refusal when no turn was ever sent, and answers a
request that raced the turn it was meant to stop. The daemon resolves each
request to **accepted / rejected / unconfirmed**.

The third arm is load-bearing. The driver declares
`interrupt.fenceOnProviderConfirmation: true`, and a host killed mid-wind-down
never answers — so a verdict that did not arrive must stay distinguishable from
one that did, or the fence is manufactured.

**Acknowledgement is not a confirmed stop.** `accepted` means
`query.interrupt()` resolved, i.e. the provider took the request. The durable
`Turn interrupted by the operator.` record is written only from `closeTurn`,
once the turn has actually ended, and is fenced on the turn epoch so one stop
yields one record. When no verdict arrived the same record instead reads
`the model host did not confirm the interrupt before the turn ended`.

A **rejected** interrupt clears the requested flag. That is what keeps late
completion honest: a turn the provider declined to stop goes on to finish, and
is reported as the completion it is rather than as a stop that never happened.

## The mutation control — nine mutants, nine single-test kills

This is the pre-fix control this cell has, and it is a unit-boundary one. Each
mutant was applied to the fixed tree, the suite run, and the file restored and
verified with `diff -q` in the same tool call.

**The claim is not "the tests pass". It is that each test fails for its own
reason** — nine mutants, nine distinct single-test kills, no overlap. A test
that cannot be reddened is not protecting anything.

| # | mutation | test it reddened (only that one) |
|---|---|---|
| 1 | drop the interrupt record on the error close | records an unconfirmed stop as unconfirmed rather than as a clean one |
| 2 | drop the interrupt record on the clean close | leaves exactly one durable interrupt record when a turn is stopped (+2 others) |
| 3 | leave the requested flag set after a refusal | says why when the provider refuses, and lets the turn finish as itself |
| 4 | silence the idle-interrupt receipt | answers an interrupt with nothing to interrupt, once per turn |
| 5 | treat a missing confirmation channel as `accepted` | treats a host with no confirmation channel as unconfirmed, never as accepted |
| 6 | **restore the original swallow in the host** | reports a refused interrupt as refused, with the provider's reason |
| 7 | map the ack frame to `accepted` regardless | reports a refused interrupt as refused, carrying the provider's reason |
| 8 | drop the ack when the child dies | reports an unanswered interrupt as unconfirmed when the host dies |
| 9 | resolve the ack deadline as `accepted` | reports an unconfirmed interrupt when a live host simply never answers |

### Mutant 6 is the one that matters, and why

Mutant 6 restores the defect **verbatim**:

    // fixed
    await ask()
    io.send({ t: 'interrupt-ack', ...id, accepted: true })

    // mutant 6 — the original line, reinstated
    void ask().catch(() => {})
    io.send({ t: 'interrupt-ack', ...id, accepted: true })

It is the closest thing this cell has to a **failing-without-the-change arm**:
it reproduces the shipped bug at the host boundary, and it reddens **only**
`reports a refused interrupt as refused, with the provider's reason` — 1 failed,
7 passed. That single-test specificity is the point. A mutant that reddens half
the suite tells you the suite is coupled, not that it is precise; this one says
the refusal test, and nothing else, is what stands between the swallow and a
regression.

Note what mutant 6 does **not** redden: the acceptance test still passes under
the swallow. That is correct and worth stating — swallowing the answer only
loses information when the answer was a refusal. A suite where the swallow
reddened the acceptance case too would be asserting something untrue.

Mutants 1 and 2 are deliberately split by close path, because the interrupted
turn reaches `closeTurn` two different ways (host death → the `Error` arm; a
polite wind-down → the `'interrupted'` arm) and a single record on one path
would have hidden a silent one on the other.

## Coverage

Fifteen focused tests. `packages/agent-runtime/src/drivers/claude-sdk/interrupt.test.ts`
is new; the rest extend files that already existed.

- **runtime** — exactly-once record; no second record on a double interrupt;
  refusal path with late-completion fencing; unconfirmed stop; no-channel
  fallback; idle interrupt, once per epoch
- **host** — acceptance only after the provider answers; refusal carrying the
  provider's reason; nothing-to-interrupt; a request that raced its own turn
- **client** — accepted; rejected; unconfirmed on host death; unconfirmed on ack
  deadline with a live but mute host; two outstanding requests answered
  separately

## Gates

Run at pin `14de478a8`, after rebasing onto `85cb15f3c`:

- workspace typecheck — 25/25 successful
- lean gate — `LEAN GATE PASSED`, 4 of 1041 files in the `node` project, 80
  tests executed. **`PODIUM_TEST_WORKERS=1` was set in this environment**; the
  number is not interpretable without that qualifier
- focused — the six Claude SDK test files through `test:related`: 6 files, 92
  tests, all passing, including the untouched conformance and runtime suites

No `test:heavy` lease was taken at any point, so this did not contend with
POD-3038's runtime redrive. No provider drive, no credentials read or copied.

## Blast radius, checked rather than assumed

**The shipping driver cannot reach this code.** That is why landing it without a
live arm costs nothing on the release bar. Checked directly, and the reason is
not quite the one it was handed to me as — worth recording, because the
conclusion survives on a stronger footing than the stated argument.

Only three files outside the changed set reach them at all:

- `apps/daemon/src/headless-drivers.ts` — dispatches on the adapter-declared
  driver KIND through `DRIVER_IMPLS: Record<HarnessHeadless['driver'], …>`,
  whose closed set is `claude-sdk`, `codex-json`, `resume-exec`. **There is no
  `claude-pty` entry in that table** — not because it was omitted, but because
  `claude-pty` is a TERMINAL driver and does not travel this path at all. The
  isolation is therefore structural rather than a matter of which branch is
  taken.
- `apps/daemon/src/headless-drivers.test.ts` — that table's own test.
- `packages/agent-runtime/src/index.ts` — a blanket
  `export * from './drivers/claude-sdk/index.js'`, so the new
  `ClaudeSdkInterruptAck` type is exported from the package. Additive only.

No exported signature narrowed. `runClaudeSdkChildTurn` now returns
`ClaudeSdkChildHandle extends HeadlessTurnHandle`, which is a widening and stays
assignable where the driver table consumes it; typecheck across all 25 packages
confirms it.

## Two fixture bugs found on the way — both faked results

Recorded because each one made a test agree with a broken world, which is the
failure mode this epic keeps paying for.

1. **The host mock closed a module-level stream slot instead of its own query's.**
   A finished test's late interrupt therefore ended the **next** test's turn,
   before that test's own interrupt command had arrived. The symptom was a turn
   that had already produced a `done` frame with no acknowledgement in it.

2. **The fake hosts searched raw stdin for the substring `interrupt`.** The turn
   frame carries the session's cwd — so in a checkout whose path contains that
   word (such as `.worktrees/issue-3043-claude-sdk-interrupt-receipt`) the fake
   answered the **turn** command as though it were the interrupt. The turn then
   "completed" before its own deadline, and
   `never reports a timed-out turn as a successful one` was red at the epic tip
   for reasons that had nothing to do with the product.

   **That red was an artefact of the directory name.** It would not reproduce in
   a normally-named checkout. Both fixtures now parse the frame instead of
   matching bytes, so the result no longer depends on where the suite runs from.
