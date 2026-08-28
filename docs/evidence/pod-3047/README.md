# POD-3047 — Claude SDK acceptance at the current epic tip

Written 2026-08-28 16:52 CEST. **Pin `593e40ef55a2e0c68f68f7f9028def95dc18d507`** — every
row below was driven at that exact tip, both arms, one named rig, no credential
copied.

## Verdict in one paragraph

**A3 passes**, with a negative control that can fail and does not. **A5 passes**,
having been a FAIL at an earlier pin in this same drive — the POD-3050 fix landed
between the two and this is its live confirmation. Nothing in the SDK column is
red. Six cells are BLOCKED, each with the product's own readout as the reason,
and none of them is counted as a pass.

## Results

`rows.tsv` carries the same 24 rows tab-separated, validated at eight fields
each, all citing pin `593e40ef5`. `docs/plans/pod-1761-results.tsv` and the
release ledger are deliberately untouched — the coordinator transcribes.

| cell | claude-sdk | claude-pty |
|---|---|---|
| A1a | **PASS** | BLOCKED (logged out, class authentication) |
| A1b | **PASS** (queued, position 1) | not driven |
| A1c | BLOCKED (no per-session host to kill) | not driven |
| A2a | **PASS** (working <2s, no flicker) | not driven |
| A2b | **PASS** | **PASS** |
| A3 | **PASS** (one confirmed record, 572ms) | not driven |
| A3NEG | **PASS** (negative control fired) | not driven |
| A4a | BLOCKED (no ask; guarded write happened anyway) | not driven |
| A4b | BLOCKED (same) | not driven |
| A5 | **PASS** (tool pair present — POD-3050 fix confirmed) | not driven |
| A6a | BLOCKED (no client terminal) | **PASS** |
| A6b | BLOCKED (no CLI terminal) | not driven |
| A7a | **PASS** | not driven |
| A7b | **PASS** | not driven |
| A8 | BLOCKED (never logged out; condition unobtainable) | BLOCKED (login path visible) |
| A9 | **PASS** (host pid gone, and gone at 5 min) | not driven |
| A10 | **PASS** `claude-sdk` | **PASS** `claude-pty` |
| B quota | **PASS** (class none) | BLOCKED (class authentication) |
| B auth | BLOCKED (never logged out) | not driven |

## A3 — the cell this issue exists for

POD-3043 landed the repair but its own brief forbade a provider drive, so it
recorded **PARTIAL** and named the open clause precisely:

> *transcript shows interrupt* — **PROVEN PRODUCED, NOT PROVEN SURVIVING** … has
> never been observed coming back out of a real instance's transcript read …
> the second clause is specifically the one a live drive could still falsify.

That is the clause this drive was for. Scored against the criterion, clause by
clause, on the current tip:

| clause | reading |
|---|---|
| turn stops | YES, 572ms after `sessions.interrupt`, from an observed in-flight `working` phase |
| exactly one durable record | YES, one item, id `claude-sdk-interrupt-<sid>-1`, role `system` |
| what it says | `Turn interrupted by the operator.` — the wording used **only** when the provider confirmed |
| **survives** | **YES** — still present in a viewer opened after the first was dropped. This is the clause POD-3043 could not close |
| exactly-once under repeated presses | YES, two further presses on the idle session left exactly one `Interrupt refused: no turn was in flight.` receipt, stop record untouched |
| refused interrupt says why | NOT EXERCISED live — the provider never refused. Covered hermetically by POD-3043 |

**The clause splits, and both halves matter.** The record survives on the session
stream. It does **not** appear in `sessions.read`, which returns `items: []` for
every claude-sdk session — filed separately as POD-3057 and *not* folded into
this verdict. Scoring A3 on that plane is what produced a zero on the first
attempt of this drive, and recorded as it stood it would have been a product red
against a repair that works.

### The negative control

A3 alone cannot separate *the wording tracks the provider* from *the runtime
always writes the confirmed sentence*. **A3NEG** freezes the `claude-sdk-host`
with `SIGSTOP` immediately before the interrupt, so the ack is undeliverable
through the **5-second deadline** rather than through the close handler — the
path `14de478a8` was written to pin. Same code, opposite sentence:

```
A3      live host      stopped in  572ms   "Turn interrupted by the operator."
A3NEG   frozen host    stopped in >10s     "…the model host did not confirm the
                                            interrupt before the turn ended."
```

Frozen pids are `SIGCONT`-ed on every exit path, including refusals.

### A race worth knowing about, seen once in five

At the intermediate pin `77c7b1d60`, one live run out of five wrote the
**unconfirmed** wording on an unfrozen host that had not refused
(`superseded-77c7b1d60/../a3-repeats/UNCONFIRMED-RUN.md`, with the console text
quoted verbatim). The path is in `requestInterrupt`: if the turn closes while the
ack is still in flight, an early return leaves `interruptConfirmation` undefined
and the record is worded *"did not confirm"* even when the provider accepted.

**The error runs conservative.** The product can under-report a confirmation it
received; A3NEG shows it does not over-report one it did not. Reported here
rather than filed, because it is a race observed once — not a rate measured —
and it degrades in the safe direction.

## A5 — a red this drive filed and then watched land

At pin `86d707d89` A5 was a genuine **FAIL**: the probe's random marker, written
only inside the fixture file and never in the prompt, came back in the assistant
reply — so a tool had read the file — while the session stream held exactly two
items, the user turn and that reply, with no tool call and no tool result of any
kind. Filed as POD-3056.

At `593e40ef5` the same probe **passes**. The Bash call now appears as a tool
item carrying `toolName`, `toolInput` and `toolUseId`, paired to a
`…-result` item carrying the file's contents, and the reload history matches.
The pre-fix arm is preserved under `superseded-86d707d89/`.

## Provenance

Three pins in one drive, because the epic tip moved three times underneath it.

| tip | non-docs delta from the previous | what was done |
|---|---|---|
| `86d707d89` | — | full both-arm drive, 15:15–15:54 CEST. A5 FAIL |
| `77c7b1d60` | **0 files** | full both-arm re-drive, 16:03–16:26 CEST. Every verdict identical — a same-code reconciliation that agreed. Plus the five-run A3 repeat |
| `593e40ef5` | **18 files** including `drivers/claude-sdk/runtime.ts`, the whole `apps/daemon/src/claude-sdk-*` stack, `packages/transcript/src/claude.ts`, and a new `tool-transcript.test.ts` | full both-arm re-drive, 16:27–16:48 CEST. **A5 FAIL → PASS.** These are the rows reported |

The first two sets are quarantined in place with a `QUARANTINE.md` each saying
what they are and why they were kept. Only `593e40ef5` readings are current, and
a script check confirms **25 of 25 readings carry `serverSha = daemonSha =
pinSha = 593e40ef5`, zero mismatches.**

**The middle re-drive was not waste and it was not evidence either.** Its value
was the zero-delta reconciliation: identical code, independently re-driven,
identical verdicts. The third was necessary — that delta lands squarely on these
cells, which is exactly when the standing brief says a reading goes stale.

## Pins, per component

Asserted by `drive.ts` before *every* cell, not once at bring-up. A run whose pin
does not match refuses rather than producing a number.

| component | how it is proven |
|---|---|
| server | `PODIUM_SPAWN_SHA` written at spawn into `server.sha`; pid liveness and cwd re-read from `/proc` per cell |
| daemon | same, `daemon.sha`; re-asserted after the A7a restart |
| web bundle | reused, `sourceSha 4d405af`: `git diff --quiet 4d405af HEAD -- apps/web` is EMPTY at every pin, so the bundle is byte-identical in code. No `test:heavy` lock taken and none needed |

`PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1` read back from `/proc/<daemon>/environ`, not
from the script that set it. Every SDK session created with an explicit
`runtimeContract: 'claude-sdk'`. `PODIUM_RUNTIME_DRIVER` unset — the drive never
forces the binding it measures. No `PODIUM_STATE_DIR`, `PODIUM_AGENT_HOME`,
`ABDUCO_SOCKET_DIR` or `TMUX_TMPDIR` override; the pin check refuses if any is set.

## Credentials — the timeline, not an assertion

Nothing was minted, copied, rotated on purpose, or printed. The isolated agent
home at `~/.local/state/podium/p3047n/agent-home` had **no `.credentials.json` at
any point**; three separate guards refuse if one appears, and A8 refuses to move
one. Only Claude's onboarding/trust flags were seeded — no token material.

**The live operator credential's mtime did change during the drive, and that is
reported rather than asserted away:**

```
78 readings' pin files record it. Two distinct values, size 962 throughout:
  08:20:34 +0200  size 962   — 46 readings, up to and including A9 at 16:11:17
  16:15:35 +0200  size 962   — 32 readings, from PTY A10 at 16:16:43 onward
```

The change falls in the window `16:11:17 – 16:16:43 CEST`. Size is identical, so
this has the shape of an in-place OAuth access-token refresh. **This drive's SDK
turns authenticate from the daemon's own HOME** — that is precisely why A8's
logged-out condition is unobtainable here — so a refresh triggered by this drive
is a plausible cause and cannot be excluded. It is permitted by the operator's
2026-08-28 ruling on subscription OAuth for the Agent SDK under an explicit
acknowledgement, which is what TOS=1 plus the explicit contract is. It is
recorded because *"unchanged"* would have been a claim this evidence does not
support.

## Host

Admissible throughout. A3 refuses above a 1-minute load of 12 — a busy host makes
a turn that would have stopped appear not to, which scores interrupt in the
flattering direction. The A3 gate was passed under that ceiling at every accepted
reading, and the one run that hit 12.98 is the `UNDRIVEN` A3NEG in the
`77c7b1d60` set, which was re-run rather than reported. No gate was run and no
`test:heavy` lock taken, so `PODIUM_TEST_WORKERS` is not applicable to anything
here.

## Limitations

- **The refused-interrupt clause of A3 has no live reading.** The provider never
  refused. POD-3043 covers it hermetically and mutation-checked.
- **A4a/A4b are the vendor-CLI auto-approve block.** Default SDK permission mode
  is `auto` and `sessions.create` exposes no way to force an asking posture, so
  the probe cannot raise an ask. What is new is that the block is *measured* —
  the guarded write landed outside the session cwd — rather than inferred from
  silence. Not a pass. If the product should expose a structured permission mode,
  that is a separate issue and not a change to this verdict.
- **A8's after-login clause is unmeasured on both arms.** Completing external
  OAuth would rotate the operator's credential deliberately.
- **A1c has no reading on this path in either direction.** The cell's premise
  does not map onto a per-turn host process.
- **`sessions.read` is empty for SDK sessions (POD-3057)** and bounds what any
  transcript-shaped cell can be scored on. Reported as its own finding, not as
  the transcript verdict.
- **PTY rows are at the same `593e40ef5` pin** as the SDK rows, but the PTY arm's
  isolated home is logged out by design, so every PTY cell needing a model reply
  is unobtainable and recorded BLOCKED with the product's own readout.
- **Every row is `[single]`** — one arm, one pin, no A/B against main.
- **One rig bookkeeping loss:** the unconfirmed A3 run's reading file was
  overwritten by the next repeat before being copied aside. Its console output is
  quoted verbatim in `a3-repeats/UNCONFIRMED-RUN.md` and is all that survives.

## Reproducing

```sh
bash docs/evidence/pod-3047/drive-up.sh                 # p3047n on 19956/46956/46957
bash docs/evidence/pod-3047/run-cell.sh A3    claude-sdk
bash docs/evidence/pod-3047/run-cell.sh A3NEG claude-sdk
bash docs/evidence/pod-3047/drive-down.sh
```

Each cell writes `pins/<driver>-<cell>.json` and `readings/<driver>.<cell>.json`.
The pin is asserted before the cell runs, so a stale rig refuses rather than
producing a number.
