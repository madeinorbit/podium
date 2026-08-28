# POD-3047 — Claude SDK acceptance re-drive after the interrupt repair

Written 2026-08-28 15:58 CEST.

The question this drive was given: does A3 pass now that the POD-3043 interrupt
repair has landed, and where does the rest of the Claude SDK headless column
stand at the exact current epic tip, with no credential copied.

**A3 passes, with a fired negative control.** Four cells that POD-3036 recorded
are recorded differently here, and in every case the difference is the
instrument rather than the product moving: A5 becomes a real FAIL, A8 and PTY
A1a stop failing for reasons that were not attributable, and A1c stops passing
for a reason that was a bystander. Those changes are argued in full below,
because a re-drive that quietly disagrees with the run before it is worth less
than one that says why.

## Provenance

Every reading post-dates the commit it is pinned to, so the commit time is a
verifiable lower bound on the whole block. Times from `date` and `git show -s`,
never estimated.

| when | what | evidence |
|---|---|---|
| 2026-08-28 15:05:48 CEST | `dd839fc54` *A stopped SDK turn leaves a record* — the POD-3043 repair | commit time |
| 2026-08-28 15:05:48 CEST | `14de478a8` *Pin the interrupt deadline, not just the death* — its test-only follow-up | commit time |
| 2026-08-28 15:07:34 CEST | `86d707d89` epic tip, the pin every reading here was taken against | commit time |
| 2026-08-28 15:14:58 CEST | rig `p3047n` up: server pid 989426, daemon pid 990109, both spawn-pinned to `86d707d89` | `drive-up.sh` output, `*.sha` files |
| 2026-08-28 15:15:20 – 15:34:44 CEST | first SDK block: A10, A3, A3NEG, A2b, A1a, A1b, A2a, A4a, A4b, A5, A6a, A6b, A7a, A7b, B quota, A8, B auth, A1c, A9 | `readings/claude-sdk.*.json` |
| 2026-08-28 15:31:15 CEST | daemon restarted by A7a, 990109 → 1096919, same sha, TOS still set | `readings/claude-sdk.a7a.json` |
| 2026-08-28 15:40:41 – 15:51:05 CEST | PTY comparison block: A10, A2b, A6a, A8, A1a, B quota | `readings/claude-pty.*.json` |
| 2026-08-28 15:54:28 CEST | SDK A1a re-driven after the A1a scorer changed, because a rule change invalidates a green reading too | `readings/claude-sdk.a1a.json` |

**Windows where nothing was driven, and why.** Between 15:22 and 15:25 the A4a
and A4b cells were re-cut to stat the marker file; between 15:29 and 15:30 A5,
A6a and A6b were re-cut onto the correct plane; between 15:33 and 15:34 A1c was
re-cut to key on `claude-sdk-host`. Each gap is instrument work on a cell whose
first reading is superseded and named as such below. No cell was left undriven
for capacity reasons — the host stayed admissible throughout (see Host).

## Pins

The three-part pin, per component, asserted by `drive.ts` before every single
cell rather than once at bring-up. A run whose pin does not match refuses.

| component | pin | how it is proven |
|---|---|---|
| server | `86d707d89ce37a5e8945a4c50bec31e8fe6a5005` | `PODIUM_SPAWN_SHA` written at spawn into `/tmp/pod-3047n/server.sha`, pid liveness and cwd re-read from `/proc` per cell |
| daemon | `86d707d89ce37a5e8945a4c50bec31e8fe6a5005` | same, `/tmp/pod-3047n/daemon.sha`; re-asserted after the A7a restart |
| web bundle | `sourceSha 4d405af`, built 2026-08-28T00:43:29.922Z | reused rather than rebuilt: `git diff --quiet 4d405af HEAD -- apps/web` is EMPTY, so the bundle is byte-identical in code to one built at the pin. No `test:heavy` lock was taken and none was needed |

`PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1` is on the daemon process (read back from
`/proc/<daemon>/environ`, not from the script that set it), and every SDK
session is created with an explicit `runtimeContract: 'claude-sdk'`.
`PODIUM_RUNTIME_DRIVER` is unset — the drive never forces the binding it is
measuring. No `PODIUM_STATE_DIR`, `PODIUM_AGENT_HOME`, `ABDUCO_SOCKET_DIR` or
`TMUX_TMPDIR` override was set; the pin check refuses if any of them is.

The `checkoutSha` field in each pin file names this issue's own evidence commit,
which runs docs-only ahead of `86d707d89` as cells are committed one at a time.
The code pin is what is asserted: `serverSha` and `daemonSha` must both equal
`86d707d89…` exactly or the cell refuses.

**Is this pin stale?** No. `git diff --name-only 86d707d89..issue/1761-agent-runtime`
filtered of `docs/` is EMPTY at the time of writing, with the epic tip since
moved on. The branch moved; the code did not.

## Credential safety

Nothing was minted, rotated, copied or printed.

- The live operator credential's mtime and size were read before and after every
  single cell and are **unchanged throughout**: `2026-08-28 08:20:34.463741791 +0200`,
  962 bytes, at bring-up and at teardown alike.
- The isolated agent home at `~/.local/state/podium/p3047n/agent-home` was
  created with **no `.credentials.json`** and had none at any point.
  `drive-up.sh`, `run-cell.sh` and `drive.ts` each refuse outright if one
  appears, and A8 refuses to move one.
- The only thing seeded into the isolated home was Claude's onboarding/trust
  state (`hasCompletedOnboarding`, `lastOnboardingVersion`) — no token material.
- SDK replies therefore come from the daemon's own operator account-home, which
  is what makes the SDK arm authenticated and the PTY arm logged out. That
  asymmetry is not incidental; it decides how A8 and PTY A1a are scored.

## Host

Admissible throughout. At bring-up: 85.7 GB root free, 16.6 GB MemAvailable.
At the A3 gate: 1-minute load 11.41, under the cell's own ceiling of 12 — A3
refuses above it, because a busy host makes a turn that WOULD have stopped
appear not to, which scores interrupt in the flattering direction. At the close
of the drive: load 7.13, 16.2 GB available, swap-in and swap-out at zero. No
gate was run and no `test:heavy` lock was taken, so `PODIUM_TEST_WORKERS` is not
applicable to anything reported here.

## A3 — the cell this issue exists for

Scored clause by clause against the criterion (*turn stops; transcript shows
interrupt; refused interrupt says why*), on the current tip, with the repair in.

| clause | reading |
|---|---|
| turn stops | YES, 688ms after `sessions.interrupt`, from an observed in-flight `working` phase |
| exactly one durable record | YES, one item, id `claude-sdk-interrupt-<sid>-1`, role `system` |
| what it says | `Turn interrupted by the operator.` — the wording used **only** when the provider confirmed the interrupt |
| durable, not a live-stream artefact | YES, still present in a viewer opened after the first was dropped |
| exactly-once under repeated presses | YES, two further presses on the now-idle session left exactly one `Interrupt refused: no turn was in flight.` receipt, and the stop record was untouched |
| refused interrupt says why | NOT EXERCISED — the provider never refused, so no `Interrupt refused by the model provider:` record was produced. Covered hermetically by POD-3043, not live here |

### The negative control, and why the PASS would be worth little without it

A3 alone cannot separate *the wording tracks what the provider said* from *the
runtime always writes the confirmed sentence*. So **A3NEG** freezes the
`claude-sdk-host` child with `SIGSTOP` immediately before the interrupt. That
makes the ack undeliverable through the **5-second ack deadline** rather than
through the close handler — a different line of code, and the one
`14de478a8` was written to pin. Same path, opposite result:

```
A3      live host      stopped in   688ms   "Turn interrupted by the operator."
A3NEG   frozen host    stopped in 10791ms   "Turn interrupted by the operator; the model
                                             host did not confirm the interrupt before the
                                             turn ended."
```

One record in each arm. Frozen pids are `SIGCONT`-ed on every exit path,
including the refusal paths.

### The first A3 reading was a false red, and it is worth saying how

Scored on `sessions.read` — which is what the POD-3036 harness used — this cell
reported **zero interrupt records**. It also reported zero of everything else,
including the user turn the probe had just watched land. `sessions.read` for a
claude-sdk session resolves through `rpc.readTranscript` into the Claude CLI's
own workdir-keyed store, and the runtime's published items never enter it. A
count taken there is a fact about the plane, and recorded as it stood it would
have been filed as a product red against a repair that works. Filed as POD-3057.

The plane the daemon actually forwards published items onto is the session
stream, and that is what every record count here is taken from. `sessions.read`
is dumped alongside in each reading so both numbers sit next to each other.

## Where this run disagrees with POD-3036, and why

Four cells. None of them moved because the product moved.

**A5: BLOCKED → FAIL.** POD-3036 read *"agent did not produce a tool call, so
pairing was not exercised"* off `sessions.read`, which is empty for every SDK
session — so that sentence was going to be produced whatever the agent did. An
unfalsifiable BLOCKED is the safest-looking wrong answer available: it reads as
caution and it retires the question permanently. The fixture marker settles it.
It is random per run, written only inside the file, never in the prompt, and the
assistant replied with it — so a tool read that file. The session stream holds
exactly two items, the user turn and that reply, with no tool call and no tool
result of any kind. Clause one of the criterion is **unmet, not unexercised**.
Filed as POD-3056.

**A8 and B auth: FAIL → BLOCKED.** The cell's premise is a logged-out spawn and
its setup is an absent credential in the isolated home. On the SDK path that
absence reaches nothing — the daemon authenticates from its own HOME — so the
session is fully logged in. Scoring *"no login path was offered"* against a
healthy authenticated session is a red attributable to nothing. The condition
now has a control read from the product rather than from the filesystem: send a
turn. It replied in 4844ms. Creating a real logged-out condition here would mean
touching the operator credential, which this rig may not do, so BLOCKED with
that reason is the complete answer. **This is not counted as a pass.**

**A1c: PASS → BLOCKED.** The first run matched `/home/mgw/.local/bin/claude auth
status` — a transient credential check that happened to be alive in the
session's directory — killed it, sent, got a reply, and reported PASS. The
session had never been dead. Keyed on `claude-sdk-host`, the target set is empty:
the SDK spawns its model host **per turn**, so between turns there is nothing to
kill. That is a structural fact about the path, and it is reported as one.

**PTY A1a: FAIL → BLOCKED.** The terminal arm's isolated home holds no
credential, deliberately. A turn that never answers there is telling us about the
account, not about the send path. The surface classifies as `authentication`
(`Not logged in  Run /login` on the screen), so the cell blocks with that reason
instead of putting a red against the driver.

Two further cells changed shape without changing meaning: **A6a and A6b** had an
applicability guard keyed on a truthy `driverFamily`, which an SDK session
reports as `null`, so it never fired — A6a reported a missing control and A6b
reported a FAIL for losing an echo from a CLI it never had. Keyed on `driverId`,
both now report *not applicable* to a path with no client terminal.

**A9 was strengthened because it could not fail.** Driven on an idle session it
asked whether zero processes remained after the kill, of a path that has zero
processes between turns anyway, and its control was satisfied by the session
merely having a `driverId`. Both halves were free. It now puts a turn in flight
first and requires the `claude-sdk-host` child in the control.

**And the green arm was re-driven after the rule changed.** The A1a scorer
gained its authentication classification while SDK A1a was already recorded
PASS. Almost nobody re-runs a green arm after changing what green means; it was
re-run at 15:54:28 and passed again.

## Results

`rows.tsv` in this directory carries the same 24 rows tab-separated and
validated at eight fields each, for transcription. `docs/plans/pod-1761-results.tsv`
and the release ledger are deliberately untouched — the coordinator transcribes.

| cell | claude-sdk | claude-pty |
|---|---|---|
| A1a | **PASS** | BLOCKED (logged out, class authentication) |
| A1b | **PASS** (queued, position 1) | not driven |
| A1c | BLOCKED (no per-session host to kill) | not driven |
| A2a | **PASS** (working at 22ms, no flicker) | not driven |
| A2b | **PASS** | **PASS** |
| A3 | **PASS** (one confirmed record, 688ms) | not driven |
| A3NEG | **PASS** (negative control fired) | not driven |
| A4a | BLOCKED (no ask; guarded write happened anyway) | not driven |
| A4b | BLOCKED (same) | not driven |
| A5 | **FAIL** (tool ran, no tool item published) | not driven |
| A6a | BLOCKED (no client terminal) | **PASS** |
| A6b | BLOCKED (no CLI terminal) | not driven |
| A7a | **PASS** (daemon 990109 → 1096919) | not driven |
| A7b | **PASS** | not driven |
| A8 | BLOCKED (never logged out; condition unobtainable) | BLOCKED (login path visible) |
| A9 | **PASS** (host pid gone, and gone at 5 min) | not driven |
| A10 | **PASS** `claude-sdk` | **PASS** `claude-pty` |
| B quota | **PASS** (class none) | BLOCKED (class authentication) |
| B auth | BLOCKED (never logged out) | not driven |

**The one red is SDK A5.** A3 is green, on the tip, with a control that can fail.

### PTY cells classified only where safe

The PTY arm was driven for the six cells POD-3036 covered and no further. The
isolated home is logged out by design and this rig may not copy a credential
into it, so every PTY cell that needs a model reply is unobtainable here and is
recorded BLOCKED with the product's own readout as the reason — not FAIL. The
useful half of the comparison is **A8**: the terminal arm *does* reach a
logged-out state and shows the login path, which is exactly the state the SDK
arm could not be put into. A6a shows the terminal plane working end to end
(7499 bytes on attach, echo, resize refit, second viewer parity) on the same
rig and the same pin, so a dead rig is not an available explanation for anything
in the SDK column.

## Limitations

- **The refused-interrupt clause of A3 was not exercised live.** The provider
  never refused, so the `Interrupt refused by the model provider:` record has no
  live reading here. POD-3043 covers it hermetically and mutation-checked.
- **A4a/A4b remain the known vendor-CLI auto-approve instrument block** (release
  ledger line 5799). What is new is only that the block is now measured — the
  guarded write landed — rather than inferred from the silence.
- **A8's after-login clause is unmeasured on both arms.** Completing external
  OAuth would rotate the operator's credential and is forbidden.
- **A1c has no reading on this path at all**, in either direction. It is not
  that the behaviour is bad; it is that the cell's premise does not map onto a
  per-turn host process.
- **`sessions.read` being empty (POD-3057) bounds what any transcript-shaped
  cell can be scored on here.** Every count in this report is taken from the
  session stream, and that choice is stated in the code that takes it.
- **One rig, one arm.** This is a single-driver reading at one pin, not an A/B
  against main. The `[single]` label on every row says so.
- **The version stamp reads `dev+86d707d-dirty`.** The tracked tree matches the
  pin exactly (`drive-up.sh` refuses otherwise); the dirt is the untracked
  `apps/web/dist` copied in for the bundle reuse.

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
