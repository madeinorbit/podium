# POD-2811 — a provider failure shows nothing for minutes

*Which of the two silences does this epic make better, and which does it leave
alone?*

The epic's bar is **better, or no worse, than main**. A silent failure is the
worst shape a user can meet, so the epic should not ship without an answer to
that question for this cell specifically. This is the answer, driven rather than
argued.

## THE FAULT, AND WHY IT NEEDS NO QUOTA

`opencode/laguna-s-2.1-free` has been **retired from opencode's gateway**. Run
directly it still fails today, on demand, with no credential to revoke and no
quota to exhaust:

```
$ opencode run -m opencode/laguna-s-2.1-free "Say hello."
Error: { "name": "UnknownError", "data": { "message": "Unexpected server error. …" } }
```

That is the fault POD-2777's `provider-error` probe uses on opencode, and this
issue keeps it. Its positive control is unchanged and is POD-2777's:
**this harness answering a normal question on this arm** (probe 1), which is
what rules out scoring an error arm that was never a working arm.

## THE TWO ARMS, MEASURED

Both on the same commit, the same rig, the same fault, the same control.
Driven with `fault-watch.ts`, which watches ONE session second by second —
see "why not just the probe" below.

| | **headless** (`opencode-server`) | **terminal** (`generic-pty`) |
|---|---|---|
| first signal of any kind | **12.2s** — `phase=errored`, `errorClass=provider-error` | **NEVER in 190s** |
| what the row says at the end | `errored` + opencode's own words | `phase=idle status=live errorClass=(none)` |
| was the turn even delivered? | yes — `"Say hello."` on the durable plane, 1 user message in opencode's store | **no** — nothing on the durable plane, no opencode session created at all |
| what the harness itself knew | the gateway's error, forwarded | the TUI printed **`Model opencode/laguna-s-2.1-free is not valid`** on screen at +4s |

**So: the epic makes this cell BETTER on the arm it introduces, and leaves the
old arm EXACTLY as it was.** Neither reading is a regression the epic caused.
The terminal arm's silence is a defect *on main*, reachable with or without this
work, and it is now POD-2812.

The terminal number is the harder one to read, and it is worse than "no error":
the harness said in plain English, on screen, four seconds in, that the model was
not valid — and the product showed a healthy idle session for the next three
minutes. It then answered later prompts on a **silently substituted model**
(`GPT-5.6 Luna`, visible in the screen tail), which nothing surfaced either.

## WHAT WAS FIXED HERE, AND WHAT THE FIRST READING MISSED

The headless arm already turned the session red before this issue — POD-2604's
landing did that. But it went red **with nothing to say**:

```
BEFORE   phase=errored  status=live  errorClass=(none)  detail=(none)
AFTER    phase=errored  status=live  errorClass=provider-error
         detail={"name":"UnknownError","data":{"message":"Model not found:
         opencode/laguna-s-2.1-free. Did you mean: hy3-free, mimo-v2.5-free,
         muse-spark-1.2-contributor-free?"}}
```

The cause is one statement. The daemon's badge is **not** the event stream: both
driver adapters answer every `state` frame by calling `handle.state()` and
sending that — *"the driver's own folded projection"*. `closeTurn` emitted a
`turn_failed` carrying the reason, the disposition and the provider's own text,
and the next statement overwrote the projection with a hand-written phase that
has no room for any of it.

**codex was worse than opencode**, and this is the finding that would not have
been made by measuring opencode alone: its `closeTurn` set `{ phase: 'idle' }`
UNCONDITIONALLY, *including* for `turn.status === 'failed'`. A turn that died
rendered on the home board as one that finished — not a near miss of the
capability catalogue's §6 row but the exact shape it names.

The fix is the one **grok-acp already had**: `foldState` reduces the emitted
change into the projection with `reduceAgentState`, the reducer every consumer
downstream uses, so the two cannot disagree. Both drivers now do that. A phase
written by hand beside an emitted change is a second reducer, and this same file
had already been bitten by it — `openAsk` carries the comment about `needs_user`
drifting from the projection for a release. This was the same bug, one arm later.

### The old tests passed throughout

They assert the **event**, which was always correct. The new ones assert
`handle.state()` and `snapshot().state` — what an operator actually sees.
Mutation-checked rather than assumed: restoring either hand-written projection
turns exactly those two tests red and leaves every event assertion green.

```
mutated (pre-fix)   Tests  2 failed | 102 passed (104)
restored            Tests  104 passed (104)
```

## WHY NOT JUST THE PROBE — the reading that had to be thrown away

POD-2777's `provider-error` probe scored the terminal arm **BLOCKED**: *"the bad
model was ignored — the harness answered normally, so no error existed"*. It is
a well-built probe and that verdict is wrong, for a reason worth recording.

The probe drives the fault while **probe 1's session is still alive in the same
directory**, and opencode's store is keyed by directory. The assistant text it
read on the fault session was `PODIUM-7ZP0U7` — probe 1's own nonce — while the
fault session's opencode row holds **1 user message and 0 assistant ones**.
Reproduced on two independent rigs with different nonces.

Driven ALONE, the same fault on the same arm shows an empty transcript and 190
seconds of nothing. So `fault-watch.ts` drives one session at a time and prints
every opencode session in the directory with its message counts beside the
verdict — the reading and the thing that could contaminate it, together. A
Podium session displaying another session's conversation is its own defect and
is now POD-2813; this file only claims what it measured.

## RUNNING IT

```bash
. docs/evidence/pod-2811/drive-env.sh          # p2811 on :19857 — NOT p2777's
bash docs/evidence/pod-2777/drive-up.sh        # headless arm
bun  docs/evidence/pod-2811/fault-watch.ts

P2777_DRIVER=generic-pty bash docs/evidence/pod-2777/drive-up.sh   # terminal arm
P2811_ARM=terminal bun docs/evidence/pod-2811/fault-watch.ts
```

**This rig has its own identity, and that is load-bearing.** Two sessions drove
`p2777` at once on 2026-08-26 and each silently killed the other: `drive-up.sh`
stops "the previous pair" through `$PODIUM_DRIVE_BASE/*.pid`, so a neighbour's
bring-up reaps yours and the survivor writes ITS commit into YOUR log. What
surfaced it was a server answering on `:19847` stamped `dev+15cdfa0-dirty` — the
POD-2777 worktree's commit — inside a log file this rig owns, minutes after the
pin check had verified `79fedcd`. Two readings were lost before the stamp was
read. POD-2777's `drive-env.sh` now takes its instance name, base and ports from
environment variables **defaulting to exactly what they were**; unset, it comes
up as `p2777` did, and no control, probe or pin leg changed.

## WHAT IS NOT CLAIMED

- **The terminal arm is not fixed.** Surfacing a TUI's own error text needs
  screen classification opencode does not have, which is POD-2812's subject and
  a different piece of work. It is measured here, not repaired.
- **codex's arm is code-verified, not driven.** No accepted-then-never-settles
  fault is known for codex, and POD-2777's probe refuses to invent one — a
  fixture must produce the thing it claims to test. The codex defect was found by
  reading the same function on the neighbouring driver and is pinned by a
  mutation-checked unit test, which is weaker evidence than a live drive and is
  said so here rather than blurred into the opencode numbers.
- **The cross-session reading's mechanism is not established.** It reproduced
  twice through POD-2777's probe; an attempt to reproduce it deliberately, with a
  companion session, failed because the companion never answered. POD-2813 has
  the open question.
