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

**Unmeasured, and I am not going to pretend otherwise.** Seven runs across four
harnesses; the control never fired once, each time for a reason that has nothing
to do with interrupt:

| harness | why the terminal cell could not be measured | reading |
|---|---|---|
| opencode | `phase` NEVER reads `working`. 49 s of a turn that put 6.6 k chars on the transcript, sampled once a second, `idle` every time (POD-2793) | `readings/opencode-terminal-phase-trace.log` |
| codex | `phase` reads `working`, but the transcript stays EMPTY until the turn ends — the two halves of the control never overlap except by a race (chars 0 → 7,198 at the same sample the phase flipped to idle) | `readings/codex-terminal-phase-trace-full.log` |
| grok | the session errors instead of running a turn | `readings/grok-terminal-interrupt-cell.log` |
| claude | the session exits immediately in the isolated agent home | `readings/claude-terminal-phase-trace-exited.log` |

POD-2777 hit the same wall from the other side: its terminal-arm interrupt cell
REFUSED, and its terminal column is still marked INCOMPLETE.

**So the question was answered a different way, by measuring the delivery
instead of the outcome** — see below. That reading is decisive and it needs no
in-flight phase on the terminal side at all, because the asymmetry is in the
daemon and is visible in its own log.

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
  reason the terminal column above is empty.
- **POD-2804** — a stopped headless turn leaves no `event:'interrupt'` mark in
  the transcript. The turn stops; the record does not say you stopped it.
