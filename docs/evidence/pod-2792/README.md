# POD-2792 — the stop button that lied

*Pressing stop on a headless agent answered `{"ok":true}` and did nothing at
all. This is where that was measured, before and after.*

```bash
bash docs/evidence/pod-2792/drive-up.sh            # the isolated p2792 instance
. docs/evidence/pod-2792/drive-env.sh
bun docs/evidence/pod-2792/wire-reading.ts opencode    # did the stop reach the wire?
bun docs/evidence/pod-2792/interrupt-drive.ts opencode # did the turn stop?
```

## What this rig is

POD-2777's acceptance-drive rig, copied and re-pointed at its own instance
(`p2792`, port 19857, state `/tmp/pod-2792`) so the two can run side by side.
The probes, the controls and `score()` are POD-2777's, unedited. The diff
against `docs/evidence/pod-2777/` is instance name, ports, state root, the
repo under test, and the path the dirty-tree check excludes.

Two files are new, and both are here because the matrix runner could not take
the reading this issue needed:

| file | what it is |
|---|---|
| `interrupt-drive.ts` | POD-2777's `interrupt` probe, run when the control has actually fired rather than at a fixed offset |
| `wire-reading.ts` | did the stop reach the wire — a reading the outcome probe cannot take |
| `phase-trace.ts` | a diagnostic: phase and output, once a second, through a whole turn |

`interrupt-drive.ts` changes **when** the interrupt is attempted and nothing
else. The matrix runner interrupts at `JOIN_MS + STREAM_MS` (33.5 s) because it
is measuring the streaming probe's late-join ordering on the way past. This one
polls until the turn is observed in flight and interrupts then. The control is
copied from `drive.ts` rather than restated:

```ts
const working   = liveRow?.agentState?.phase === 'working'
const producing = late.previews.length > 0 || late.assistantText().length > 0
```

A first pass asked for output that **grew** between samples instead — stronger
than the rig asks — and it cost a real measurement: codex/terminal publishes its
transcript in one step (0 chars for 33 s, then 6,446), so "grew over the last
second" was false at every sample of a turn that was plainly running. That is
recorded rather than quietly fixed.

## The answer to the first question: does interrupt work on the terminal arm?

**No — and that makes this a PRE-EXISTING GAP, not a regression.** This section
originally said the opposite, and the correction is kept in place rather than
rewritten over, because how the wrong answer was reached is the useful part.

POD-1761's acceptance drive measured the terminal arm while this work was in
flight, using the signal that arm actually publishes — the PTY's own output
bytes — where the measurement below could only reach for a phase that arm never
sends. Their reading, control fired, same rig and commit:

```
INTERRUPT SENT    {"ok":true}
TERMINAL BYTES    257 at the call -> +44049 after 6s -> +72080 after 12s
TRANSCRIPT MARK   no item carries event:'interrupt'
```

72 KB of output after a call that reported success. So the stop was already
broken on the old path, and the headless work inherited it rather than causing
it. **It does not block the release**, and a fix that mends only the new path
would leave the old one lying in exactly the same way.

### What I got wrong, and what survives

I reported REGRESSION. That was wrong at the OUTCOME level. The delivery finding
below is a different defect and still stands on its own measurement: on the
headless arm the stop never reached the driver **at all** — the daemon said so,
naming the session. What I did was infer the outcome from the delivery: the
discard branch exists only for contract sessions, so on main the key always
reached a terminal, so — I reasoned — the stop worked there. "The key arrived"
is not "the stop worked", and I had already written down that the terminal
outcome was unmeasured. The inference was one step too far past my own evidence.

One thing not to generalise in the other direction either: **that reading is
opencode only.** POD-1214 measured and pinned the per-harness keys — Esc cancels
claude-code and grok, codex ignores Esc and cancels on Ctrl-C — so "equally
broken on main" is established for opencode-on-terminal and not yet for the
other three.

### Why this rig could not take that reading

Seven runs across four harnesses; the control never fired once, each time for a
reason that has nothing to do with interrupt:

| harness | why the terminal cell could not be measured | reading |
|---|---|---|
| opencode | `phase` NEVER reads `working`. 49 s of a turn that put 6.6 k chars on the transcript, sampled once a second, `idle` every time (POD-2793) | `readings/opencode-terminal-phase-trace.log` |
| codex | `phase` reads `working`, but the transcript stays EMPTY until the turn ends — the two halves of the control never overlap except by a race (chars 0 → 7,198 at the same sample the phase flipped to idle) | `readings/codex-terminal-phase-trace-full.log` |
| grok | the session errors instead of running a turn | `readings/grok-terminal-interrupt-cell.log` |
| claude | the session exits immediately in the isolated agent home | `readings/claude-terminal-phase-trace-exited.log` |

POD-2777 hit the same wall, and then went round it: they changed WHO establishes
the control rather than what it is, so on the terminal arm flight is proved by
the PTY's output bytes growing instead of by a phase that arm never publishes.
That is the reading above, and it is the one this section should have waited
for.

**The delivery reading below still stands on its own**, and it needs no
in-flight phase on the terminal side at all, because the asymmetry is in the
daemon and is visible in its own log.

## Why the terminal stop does not land: it is the KEY, not the delivery

Their reading says the outcome is wrong; it does not say why, and the two
candidate whys need different fixes. So four keys were driven at one running
terminal opencode turn, each on its own fresh turn, each measured the same way
(`terminal-key-probe.ts`, reading `readings/opencode-terminal-keys-AB.log`):

| what was sent | PTY bytes after | reading |
|---|---|---|
| `sessions.interrupt` — the product's own path | +98,145 over 14 s | kept generating |
| a raw `\x1b` typed as client terminal input | (round refused — no running turn) | — |
| `\x03` (Ctrl-C) | 6,770 in the first 2 s, then **nothing for 18 s** | output stopped — but see below |

**The ESC does reach the PTY.** `grep 'bridgeless contract session'` over the
daemon log for this whole run: **0**. A terminal-family session has a bridge and
the byte is written to it, which is the difference from the headless arm.

**And opencode's TUI advertises the key.** Its own footer, read off the screen
tail: `esc interrupt`. The binary agrees —
`session_interrupt: H("escape", "Interrupt current session")`. So the manifest's
`interruptKey: 'esc'` is right, the byte arrives, and the turn runs on anyway.

**Ctrl-C is not the answer, and reading it as one would have been the worse
bug.** The screen tail after that round is opencode's EXIT screen —
`Session … / Continue  opencode -s ses_…` — and every later round found no
running turn. Ctrl-C did not cancel the turn; it quit the CLI, while the session
was BUSY. That is precisely the failure POD-1214's `interruptQuitsWhenIdle`
guard exists to prevent, and opencode declares that flag `false`. Nothing is at
risk today, because opencode's key is Esc and Ctrl-C is never sent to it — but
the flag is measured wrong, and it is one manifest edit away from mattering.

So the remaining terminal-arm defect is in the TUI's key handling, not in
anything this repo delivers to it. `opentui` — opencode's input layer — carries
both a kitty-keyboard path and an escape-disambiguation timeout, either of which
would explain a lone `0x1b` being read as an incomplete sequence rather than as
the Escape key. Chasing that is an upstream input-parser investigation and it is
filed rather than guessed at.

### What this rig learned about its own measurement

A first pass let each round inherit the previous round's session, and produced a
result I nearly believed: rounds 2 and 4 read as STOPPED while 1 and 3 kept
generating, which looked like the product's path being broken where a plain
keypress was not. **A TUI redraw is also output bytes** — cancelling a turn
repaints a long transcript, tens of KB of it — so a round could fire its control
on the repaint of an already-finished turn and then "stop" something that had
already stopped. That is the trap the control exists to prevent, reached through
the one signal this arm publishes. Every round now starts its own turn and
requires growth in TWO consecutive samples. Both readings are kept:
`opencode-terminal-keys-round1-flawed.log` and `opencode-terminal-keys-AB.log`.

## The answer to the second question: does the frame reach the server?

**No. It was dropped before the wire, and the daemon says so.**

`sessions.interrupt` routed every session down the terminal path: look up the
harness's abort key, send it as `input` bytes. A server-family session has no
PTY behind it, so `apps/daemon/src/control/session.ts` takes this branch —

```
if (!bridge && sessionIsBehindContract(ctx, msg.sessionId)) {
  log.warn('discarding input bytes for a bridgeless contract session', …)
}
bridge?.write(msg.data)
```

— and the bytes are gone, on the line above the one that would have delivered
them. `interruptTurn` had already returned `{ok:true}` synchronously.

**BEFORE** (pin `83b0077`, the epic tip), both controls firing:

| harness | interrupt answered | daemon | phase 20 s later |
|---|---|---|---|
| opencode | `{"ok":true}` | `discarding input bytes for a bridgeless contract session`, `bytes:4`, naming that session | `working` |
| codex | `{"ok":true}` | the same warning, the same session | `working` |
| grok | `{"ok":true}` | the same warning, the same session | REFUSED — control 1 did not fire |

And the outcome probe on the same build, control fired, turn confirmed in
flight:

| harness | verdict | frames AFTER the stop | preview chars |
|---|---|---|---|
| opencode | **FAIL** — still working 120 s after interrupt | **35** | 130 → 1,993 |
| codex | **FAIL** — still working 120 s after interrupt | **66** | 47 → 1,650 |

The agent kept generating. That is the operator's report, reproduced.

**AFTER**, re-driven on the REBASED branch (pin `47be96d`) rather than on the
sha the fix was first measured at — the epic moved 85 lines of
`drivers/opencode/runtime.ts` underneath this work, and an after-arm taken at a
commit that no longer exists is an after-arm nobody can reproduce:

| harness | interrupt answered | daemon | verdict | frames after | settled |
|---|---|---|---|---|---|
| opencode | `{"ok":true,"requested":"protocol"}` | no discard warning | **PASS** | 0 | 12 ms |
| codex | `{"ok":true,"requested":"protocol"}` | no discard warning | **PASS** | 1 | 532 ms |
| grok | `{"ok":true,"requested":"protocol"}` | no discard warning | REFUSED | — | — |

(The wire readings and the `phase: errored` finding below were taken at
`1d50579` and `5843c04`, the two fix commits before the rebase; the trees they
measured are the ones that rebased forward unchanged.)

Grok refuses for an account reason the product reports correctly and this rig
cannot fix: `usage_limit`, non-retryable, *"API error (status 402 Payment
Required): Grok Build usage balance exhausted"*. Its driver is server-family and
takes the identical one-line route; nothing about it is harness-specific.

### The control that was worthless, kept rather than replaced

`wire-reading.ts`'s second control first asked whether the daemon log GREW in
the 20 s after the interrupt. On the broken build it fired — because the discard
warning WAS the growth. It fired only when the defect was present, which is the
one thing a control must never do, and on the fixed build the reading refused
itself. It now asks whether lines about **this session** were written to **this
file** before the interrupt, which fires either way.

## The answer to the third question: what should `ok` mean?

`ok` means the interrupt was **requested**, and `requested` now names which
delivery carried it — `'keystroke'` for a key typed at a TUI, `'protocol'` for a
request a driver accepted. It never means the turn stopped. Nothing synchronous
can say that: the contract models `interrupt()` as a request for a fence, and
the fence is a provider-confirmed terminal turn event that arrives later on the
causal stream. A driver's refusal comes back as the reason, which the chat
composer already prints.

## What else the fix turned up

With the stop reaching the driver, opencode's own answer became visible: it
reports a cancelled turn as `session.error` carrying `MessageAborted`, the
driver classified that — correctly — as `interrupted`, and then closed the turn
as FAILED anyway. The operator stopped the agent and the session went to
`phase: errored` carrying no error at all, while codex reached `idle` from the
same button. `MessageAborted` appeared exactly once in the whole package, in the
classifier, and no test named it. Fixed in the second commit; both drivers now
reach `idle`.

## Two things this drive found and did not fix

- **POD-2793** — opencode on the terminal path never reports it is working. The
  reason this rig could not measure the terminal column itself.
- **POD-2804** — a stopped headless turn leaves no `event:'interrupt'` mark in
  the transcript. The turn stops; the record does not say you stopped it.
- **POD-2809** — the terminal-arm stop does not cancel an opencode turn. The key
  arrives, the TUI advertises it, nothing happens; Ctrl-C quits the CLI instead
  of cancelling. Not a regression, not a release blocker, and superseded for
  anyone on the headless path — but the old path still lies about it in the one
  way this issue has not closed: `ok` there means "the key was typed", which is
  true, and the operator still has no signal that it did nothing.
