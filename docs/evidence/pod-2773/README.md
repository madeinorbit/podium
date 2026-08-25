# POD-1761's acceptance test, on the two harnesses nobody had driven

Chat streaming was proven on **codex** by driving it: a viewer joining 8.5s into a
running turn saw 119 preview frames against 0 with the pre-fix driver. **grok-acp**
and **opencode** take the same code path, were unit-tested, and had never been
watched. This is the record of driving both.

**One is proven. One is blocked, and blocked is not broken.**

| harness | driver bound | fine watch | positive control | preview frames | what it means |
|---|---|---|---|---|---|
| **opencode** | `opencode-server` | ACQUIRED | fired (2 frames, +17ms) | **12**, 5 → 1340 chars, monotonic | **streams** |
| opencode *(control)* | `generic-pty` | not acquired | fired (2 frames, +494ms) | **0** | the terminal driver, same script |
| **grok** | `grok-acp` | **ACQUIRED** | fired (1 frame, +27ms) | not reportable | **blocked on credit**, not on code |

All three rows are the same rig at the same commit (`aa30985c8`), same prompt, same
join delay, verified before each drive.

## The instance

Port base **19837** (`p2773`, state under `/tmp/pod-2773`). Deliberately not the
operator's 19797, and `drive-verify.sh` refuses to run against that port at all.

## What was driven, and in what order

The session is started with a prompt, so it is **busy from its first moment**, and the
chat opens **~8.5s later, into a turn already in flight**. That ordering is the
experiment. It is the case that used to show nothing at all — reaching the fine watch
was a reconnect, a reconnect abandons an in-flight turn, so the upgrade could only land
in an idle gap and the turn a viewer walked in on was always the turn that streamed
nothing. It is also the normal case: anyone who starts a session and then looks at it
is in it. A drive that opens the chat first and then sends measures the easy ordering
and would have passed on the broken build.

## opencode streams

Bound driver `opencode-server`, family `server` — the headless driver, not a PTY
fallback. The reply built in the chat pane the whole time it was being written:

```
first  +63ms    epoch=1 seq=5    rows=1  chars=5
last   +1232ms  epoch=1 seq=346  rows=1  chars=1340
growth: 11/11 transitions increased the visible character count
monotonic per row: YES — no row ever shrank
```

Monotonicity is measured **per row, not on the total**, and the distinction is not
pedantry: every frame carries the whole preview, and a row is *retired* the moment the
durable item carrying its identity lands on the transcript plane. The total therefore
drops legitimately at a retirement, and a naive check on the total would call a
correct stream non-monotonic.

## The control: the same script on the terminal driver

`PODIUM_RUNTIME_DRIVER=generic-pty`, everything else identical — same rig, same prompt,
same join delay, same socket, same subscription. The turn ran to completion
(`phase=idle`) and the terminal was visibly alive (**86 output frames**). Preview
frames: **0**. The daemon logged no fine watch for it, which is the mechanism rather
than a symptom: `generic-pty` declares `watchLevels: ['coarse']`, so the watch
lifecycle's capability gate declines to take a fine watch and no fragments are ever
produced.

A second, narrower control — the same `opencode-server` driver with the preview plane
switched off (`PODIUM_CHAT_STREAMING=0`) — also produced **0 preview frames with the
control firing**, at commit `a984382`. That one differs from the treatment in exactly
one variable. Its re-run at the final commit is the one measurement this drive lost:
the box hit load 59 with 800MB free, the session went `reconnecting`, and the rig
refused to report it rather than printing a zero. That refusal is the rig working.

## grok is blocked on credit, and the distinction is the finding

```
BOUND DRIVER   grok-acp (family server)
FINE WATCH     ACQUIRED — the daemon moved the driver refcount for this session
TURN ERROR     usage_limit — API error (status 402 Payment Required):
               Grok Build usage balance exhausted
```

Reproduced outside the rig entirely, on a plain `grok -p` against `$HOME`: same 402.
One OAuth account, no alternate provider configured, `workingMsTotal: 883` before it
died.

**This is not "grok does not stream".** The brief asks which of three explanations a
zero has — the driver connects coarse and never upgrades, the frames are produced and
dropped, or the viewer never subscribes — and the answer is **none of them**:

- the **grok-acp** driver bound, not a PTY fallback;
- the viewer **did** subscribe, and the daemon **did** acquire the fine watch, so the
  whole chain from `transcriptSubscribe` → `reconcileWatchLevel` → `runtimeWatch fine`
  → the driver's refcount worked across the process boundary;
- the provider then refused before a single token existed, and the product classified
  it correctly as `usage_limit`.

Everything up to token production is observed working. The only unobserved leg is the
one that needs tokens. **Give that account credit and this is a ten-minute drive.**

## Why this rig is mostly refusals

The epic's failure mode has never been the drive — it is believing a number. Three
stale-rig conclusions, and one near-rejection of a working fix. So:

1. **`drive-verify.sh` reads the arm back out of the running daemon's
   `/proc/<pid>/environ`.** Both flags are read once at composition, so a value
   exported *after* a process started is a value it has never seen, and the drivers
   load at the daemon's process start — repinning a checkout underneath a running
   daemon changes nothing at all. It also checks each process started *after* the
   commit was made. It caught its own case twice during this work.
2. **A positive control on the same socket.** `transcriptDelta`, the durable plane,
   established by the same `transcriptSubscribe` that raises the watch level. No
   preview count is printed — zero included — unless it fired. It refused twice, both
   times correctly.
3. **A second gate for turns that never ran.** The socket control was not enough, and
   grok is why: its turn errored on the provider while the durable frame still landed,
   so the socket control fired and the rig would have printed `PREVIEW frames=0` about
   a turn in which no token was ever generated.
4. **The bound `driverId`, printed beside every number.** An isolated agent home
   missing a harness credential does not fail loudly — the server driver declines, the
   session degrades to a generic PTY, and a PTY produces exactly zero fragments. By
   frame count alone that is indistinguishable from a broken feature.

## What went wrong on the way, kept because it is instructive

**`PODIUM_RUNTIME_CONTRACT=0` is not a control.** It is only the machine-wide half of
`runtimeContractEnabledFor` — a session carries its own — so an opencode session bound
`opencode-server` with the machine flag off, and that "control" arm reported **25
preview frames**. It had measured the treatment. Nothing in the numbers said so. The
only thing that gave it away was the bound `driverId` printed beside them.

**The first terminal-driver control never ran a turn.** A `generic-pty` opencode
session created with an `initialPrompt` was left sitting at an empty TUI prompt — no
turn, no transcript, no control. The rig refused to report it, which is the gate
working, but a refusal is not a control either; hence `P2773_PROMPT_MODE=send`, which
sends the prompt the way a person does and only then starts the join clock.

## Running it

```bash
bash docs/evidence/pod-2773/drive-up.sh
bash docs/evidence/pod-2773/drive-verify.sh HEAD
. docs/evidence/pod-2773/drive-env.sh
P2773_PROMPT_MODE=send bun docs/evidence/pod-2773/drive.ts opencode

# the control
P2773_DRIVER=generic-pty bash docs/evidence/pod-2773/drive-up.sh
P2773_DRIVER=generic-pty bash docs/evidence/pod-2773/drive-verify.sh HEAD
bash docs/evidence/pod-2773/drive-down.sh   # reaps the ~400MB server each arm leaves
```

`drive-down.sh` matters on this box. Each arm leaves a session the daemon adopts on its
next boot, and four arms was 1.2GB of a 12GB host.
