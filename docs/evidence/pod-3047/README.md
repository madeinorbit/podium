# POD-3047 — Claude SDK acceptance at the current epic tip

> **NOT FINAL — DO NOT TRANSCRIBE THESE ROWS.**
> Coordinator instruction, 2026-08-28 17:47 CEST: the `90ebca7d9` rows are held
> pending **POD-3057**. The reason is in this report — POD-3059 did not reach the
> claude-sdk path, so `sessions.read` is still empty here and every
> transcript/read-dependent cell must be re-driven at the repaired tip once
> POD-3057 lands. A5 and A3 at minimum, plus any cell whose proof touches the
> read path.
>
> **What still stands regardless of POD-3057:** the *finding* that POD-3059 does
> not reach this path (measured three ways, below) — that is what POD-3057 is
> for. And the cells scored purely on the session stream or on process state are
> unaffected by the resolver either way; they will be re-confirmed, not rescued.
>
> An earlier mail from this issue asked the coordinator to transcribe these rows.
> **That request is withdrawn.**

Written 2026-08-28 17:38 CEST. **Pin `90ebca7d94d0e68f4744c6a8425eed30cf5b0b10`** — every
row below was driven at that exact tip, both arms, one named rig, no credential
copied.

## Verdict in one paragraph

**A3 passes**, with a negative control that can fail and does not. **A5 passes**,
having been a FAIL at an earlier pin in this same drive — the POD-3050 fix landed
between the two and this is its live confirmation. Nothing in the SDK column is
red. Six cells are BLOCKED, each with the product's own readout as the reason,
and none of them is counted as a pass.

**One negative finding about landed work, and it gates somebody else:**
**POD-3059 does not reach the claude-sdk path.** `sessions.read` is still empty
here, measured three ways at this pin. See *What POD-3059 did and did not fix*.

## Results

`rows.tsv` carries the same 24 rows tab-separated, validated at eight fields
each, all citing pin `90ebca7d9`. `docs/plans/pod-1761-results.tsv` and the
release ledger are deliberately untouched — the coordinator transcribes.

| cell | claude-sdk | claude-pty |
|---|---|---|
| A1a | **PASS** | BLOCKED (logged out, class authentication) |
| A1b | **PASS** (queued, position 1) | not driven |
| A1c | BLOCKED (no per-session host to kill) | not driven |
| A2a | **PASS** (working <2s, no flicker) | not driven |
| A2b | **PASS** | **PASS** |
| A3 | **PASS** (one confirmed record, 538ms) | not driven |
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
| turn stops | YES, 538ms after `sessions.interrupt`, from an observed in-flight `working` phase |
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
A3      live host      stopped in  538ms   "Turn interrupted by the operator."
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

At `90ebca7d9` the same probe **passes**. The Bash call now appears as a tool
item carrying `toolName`, `toolInput` and `toolUseId`, paired to a
`…-result` item carrying the file's contents, and the reload history matches.
The pre-fix arm is preserved under `superseded-86d707d89/`.

## What POD-3059 did and did not fix

POD-3059 (`1b5ebc9c1`, `ccdea1f93`) landed to stop a headless child writing its
JSONL under the operator account home while the transcript reader resolved it
under the instance agent home — the bug that makes `sessions.read` answer with an
empty page. It is the fix for POD-3057, which this drive filed. Decision 32 then
reasons from it that a set of *"turn stopped, no transcript marker"* reds across
three drivers may have been manufactured by that empty reader.

**On the claude-sdk path, at this pin, it has not taken effect.** Measured three
ways rather than argued:

1. **The child's `HOME`, read from `/proc`.** A `claude-sdk-host` child (pid
   1660624) spawned by the `p3047n` daemon at `90ebca7d9`, on a **named**
   instance, runs with `HOME=/home/mgw` — the operator account home. The instance
   agent home is `~/.local/state/podium/p3047n/agent-home`.
2. **Where the JSONL lands.**
   `/home/mgw/.claude/projects/-tmp-pod-3047n-probes-rawread/<uuid>.jsonl` exists.
   The instance agent home has **no `projects` directory at all** — nothing was
   ever written there.
3. **`sessions.read`, raw response**, not through this rig's helper:
   `{"sessionId":"2ad58d0d-…","items":[],"cursor":null,"hasMore":false,"truncated":false}`
   on a session whose reply had just arrived on the stream (stream items: 2).

**A pointer, labelled as a pointer rather than as the diagnosis.** POD-3059 fixed
the *overlay* a headless turn hands to `headlessChildEnv`. But
`apps/daemon/src/claude-sdk-client.ts:322` calls
`headlessChildEnv(spec.agent, spec.env)` directly, and that function's own
signature is unchanged — its `HOME` comes from `explicit?.HOME` with
`process.env` spread underneath. So the claude-sdk child gets the instance home
only if `spec.env` already carries it, and this reading says it does not. The
other candidate is ruled out: `claudeSdkHostLaunch()` contributes only
`{ CLAUDE_SDK_HOST_ENV: '1' }` and injects no `HOME`, so the trailing
`...launch.env` spread is not overriding it. Where `spec.env` is built was not
traced.

**What this does to Decision 32.** Its one-way-direction argument is untouched
and still right — an empty read can only make a cell look worse, never
manufacture a PASS. But its premise, that the shared headless path is fixed for
`claude-sdk`, is false as measured. A re-read that expects a working reader will
see the claude-sdk row come back red and may record a confirmed product gap where
the reader is still the same empty one. `/proc` `HOME` on the child is a
ten-second check and is the one that cannot be argued with; `codex-json` and
`resume-exec` are worth the same check.

**None of this reaches the cells in this report**, because every count here is
taken from the session stream — a choice forced by hitting this exact bug on the
first A3 reading of the drive.

## Provenance

Four pins in one drive, because the epic tip kept moving underneath it. The rule
applied at each move was the standing brief's: compute the non-docs delta, and
re-drive when — and only when — it lands on these cells.

| tip | non-docs delta from the previous | what was done |
|---|---|---|
| `86d707d89` | — | full both-arm drive, 15:15–15:54 CEST. **A5 FAIL** |
| `77c7b1d60` | **0 files** | full both-arm re-drive, 16:03–16:26 CEST. Every verdict identical — a same-code reconciliation that agreed. Plus the five-run A3 repeat |
| `593e40ef5` | **18 files** including `drivers/claude-sdk/runtime.ts`, the whole `apps/daemon/src/claude-sdk-*` stack, `packages/transcript/src/claude.ts` and a new `tool-transcript.test.ts` | full both-arm re-drive, 16:27–16:48 CEST. **A5 FAIL → PASS** (POD-3050) |
| `90ebca7d9` | **4 files**: `durable-headless.ts`, `headless-drivers.ts` and their tests — POD-3059, the headless spawn seam A8's verdict rests on | full both-arm re-drive, 17:10–17:34 CEST. Every verdict held. **These are the rows reported**, and this pass is what established the POD-3059 finding below |

The first three sets are quarantined in place with a `QUARANTINE.md` each saying
what they are and why they were kept. Only `90ebca7d9` readings are current, and
a script check confirms **25 of 25 readings carry `serverSha = daemonSha =
pinSha = 90ebca7d9`, zero mismatches.**

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

At the CURRENT pin (90ebca7d9, 17:10–17:34) it did not move at all:
  16:15:35 +0200  size 962   — all 26 current-pin readings, one distinct value
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
- **PTY rows are at the same `90ebca7d9` pin** as the SDK rows, but the PTY arm's
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
