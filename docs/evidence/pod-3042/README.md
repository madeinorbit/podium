# POD-3042 — default main-arm baselines

Recorded 2026-08-28 (CEST). This evidence covers exactly the two POD-1761
cells that were still marked `regression status UNRESOLVED`:

- A6b chat↔CLI switch both directions twice — OpenCode
- A3 interrupt mid-turn — Codex

The main arm ran on the `default` instance while the `instance:default` lock
was held by POD-3042. No named instance was used for a main run. The earlier
named-arm `abduco ... File name too long` failure is therefore not reused as a
baseline.

## Result at a glance

| cell | main arm actually exercised | positive control | main-arm reading |
|---|---|---|---|
| A6b / OpenCode | main's native legacy generic-PTY fallback; main has no `opencode-server` driver | FIRED: chat answered and CLI nonce echoed before switching | Valid measured baseline is PARTIAL: switching, no-restart, size, and both post-switch actions passed; scrollback corruption is UNMEASURED |
| A3 / Codex | main's native legacy generic-PTY fallback; main has no `codex-app-server` driver | FIRED: post-prime PTY output grew while the session was `phase=working` | No exact app-server comparator; valid legacy fallback is PARTIAL: interrupt stopped the turn, but the transcript marker was absent |

VERDICT — A6b/opencode-server MAIN: **PARTIAL measured baseline** — the
control-backed main legacy route passed chat↔CLI switching, no-restart, size,
and both post-switch actions; scrollback corruption remains `UNMEASURED`.
Main predates the exact `opencode-server` driver, so the CLI-after-switch
failure on the epic is worse than this provider-level legacy reading, but this
is not an exact same-driver regression proof.

VERDICT — A3/codex-app-server MAIN: **NO EXACT COMPARATOR** —
`codex-app-server` is undriveable on main because that driver does not exist in
the pinned old code. A separate control-backed legacy generic-PTY reading is
`PARTIAL`: the interrupt was accepted, output stopped, and the final row was
`idle.interrupted`, but no `event:'interrupt'` transcript marker appeared.
This is not an exact-main PASS or FAIL and does not establish a regression for
the epic's missing marker.

## Pins and rig

### Product pins

| item | exact value |
|---|---|
| local main SHA used for both main runs | `0bd90092c3a926b9305da34547fcc51b1e19b0a7` |
| main subject | `Test rigs use named instances` |
| main checkout | `/tmp/pod-3042-main` (clean detached checkout) |
| main served web bundle | `sourceSha=0bd9009`, `appVersion=dev+0bd9009`, `bundleVersion=bundle+_NeGkVql` |
| current epic ref checked for this report | `issue/1761-agent-runtime` → `5fe951f2fe5ff3300330d64a3a5b0a4df3a76fe` |
| scored epic pin for the comparison readings | `38a2d1a7ab9aa75550aff089cb632ce3f1aee368` |
| scored epic evidence | `docs/evidence/pod-3038/README.md` |

The A6b and A3 epic readings being contrasted here were scored in
POD-3038 at `38a2d1a`. The current epic ref is recorded separately above; the
post-`38a2d1a` product changes visible at report time are Claude SDK changes,
not changes to the Codex/OpenCode driver paths used by these two cells.

### Default-instance isolation

The lock was acquired before bring-up and held through both valid readings.
The product-derived state root was `/home/mgw/.podium`; the default
`~/.abduco` socket location was used. `PODIUM_STATE_DIR`,
`PODIUM_AGENT_HOME`, `ABDUCO_SOCKET_DIR`, `TMUX_TMPDIR`, and
`PODIUM_RUNTIME_DRIVER` were not set, and no product path override was
supplied. The isolated harness used a non-operator port but left the product's
default state and socket derivation unchanged.

The exact pre-run pin checks passed for each run:

| cell | server | daemon | port | web source | contract / streaming |
|---|---:|---:|---:|---|---|
| A6b | pid `78`, spawned at `0bd9009` | pid `136`, spawned at `0bd9009` | `19847` | `0bd9009` | `1 / 1` |
| A3 | pid `67`, spawned at `0bd9009` | pid `123`, spawned at `0bd9009` | `19849` | `0bd9009` | `1 / 1` |

No main process was started from the epic checkout, and main was not merged
into the epic branch.

### Agent binaries

| binary | path used inside the rig | version | cell |
|---|---|---|---|
| Bun | `/home/mgw/.bun/bin/bun` | `1.3.14` | both |
| OpenCode | `/home/mgw/.opencode/bin/opencode` | `1.18.16` | A6b |
| Codex | `/home/mgw/.local/bin/codex` (staged from the 0.149.1 standalone release) | `codex-cli 0.149.1` | A3 |

The old daemon logged `codex-version-unsupported` for `0.149.1`; that is the
expected pre-app-server hook gate on main. It did not prevent the legacy PTY
session from becoming observably live in the valid A3 run.

## A6b — OpenCode

### Main run

Run window: `2026-08-28 14:21:52–14:25:37 CEST`.

Session: `e6ae28a6-166c-4cca-a4d4-bcad61405d6b`.

The old main API reported `driverId=(none)` and `family=?`; this is an old
API shape, not a no-session result. The process census showed main's native
OpenCode terminal route: `abduco` pid `408`, OpenCode pid `409`, and its
attach client pid `412`. The run is consequently a legacy generic-PTY
comparator, not an `opencode-server` session.

The positive controls fired before any switch:

- Chat answered before switching, and the TUI painted the marker into
  scrollback: `true`.
- CLI echoed before switching: `true` (`107315` terminal bytes).

Baseline epoch was `0`; baseline geometry was `80x24`; the baseline marker
appeared `8` times in `1` non-blank line. The required sequence was
`chat → CLI → chat → CLI`:

| step | view | epoch | geometry | marker | marker count | order | non-blank lines | terminal bytes |
|---:|---|---:|---|---|---:|---|---:|---:|
| 1 | chat | 0 | `80x24` | true | 8 | true | 1 | 107411 |
| 2 | CLI | 0 | `80x24` | true | 12 | false | 1 | 177587 |
| 3 | chat | 0 | `80x24` | true | 12 | false | 1 | 177587 |
| 4 | CLI | 0 | `80x24` | true | 16 | false | 1 | 258679 |

The no-restart witnesses passed: epoch stayed `0`, and the scored process
census stayed `[1, 2, 391, 392, 408, 409, 412]`. After the four switches:

- Chat answered with nonce `CHATAFTER-6VQ9O0`: `true`.
- CLI typing echoed: `true` (`+105682` terminal bytes).

The scrollback clause was not scored as a pass. The marker survived and its
count grew, but the line-order check was false; this probe cannot distinguish
terminal repaint/reflow from corruption without a terminal emulator screen
model. The same scrollback clause is `UNMEASURED` on the epic arm, so no new
scrollback claim is made here.

### Epic contrast

POD-3038's scored epic OpenCode run at `38a2d1a` bound
`opencode-server`/`server` and also fired both positive controls. It completed
the same four declared switches at `120x40`, kept epoch `0`, and chat answered
afterward (`CHATAFTER-SW8SH1`). CLI typing after the switches did not echo the
nonce (`false`, despite `+32735` terminal bytes), while the scrollback clause
was also `UNMEASURED`.

Thus the measured main legacy reading has CLI-after-switch `true` where the
epic server reading had `false`; the differing driver families are the reason
the verdict above is phrased as a provider-level baseline rather than an exact
same-driver regression.

## A3 — Codex

### Exact-driver availability

The pinned main tree predates the `codex-app-server` implementation. Main's
native Codex route is a generic PTY/TUI route, so the exact requested
app-server comparator cannot be driven on main. The stock standalone A3 probe
was attempted and correctly discarded:

- Session `1289a2c2-52b1-42bd-a5cd-5a1c6e1c334f` never produced an app-server
  binding or a valid live-turn control.
- Its control reading was `phase=unknown`, `0` preview frames, `0` new
  transcript characters, and `12826` terminal bytes.
- It ended `REFUSED`; it is not a baseline and is not a main failure.

### Valid legacy fallback run

Because the exact app-server route is absent on main, a separate diagnostic
runner (`a3-main-legacy-diagnostic.ts` in this evidence directory) primed the
old TUI and required an independent, post-prime control: the row had to report
`phase=working`, the PTY had to grow after the prompt, the sample had to be at
least one second after the prompt, and the sample could not be a trust/hooks
modal. This avoids counting first-run prompts or repaint noise as an
in-flight-turn control.

Run window: `2026-08-28 14:43:14–14:44:33 CEST`.

Host one-minute load at drive start: `4.01` (below the brief's `<12` gate).

Session: `66a65862-3f67-4624-bb56-37994024b894`.

The session opened at `80x24`. The old Codex TUI first showed a directory trust
prompt (`2137` terminal bytes); the runner pressed Enter three times. After
priming, the screen had `11200` bytes (`+9063`), with the input prompt
available. The Codex UI also reported an unrelated logged-out Cloudflare MCP
startup; the turn-control signal below was still observed on the live PTY.

The prompt was sent, then the runner observed:

| reading | value |
|---|---|
| samples before control | `5289ms`: `phase=unknown`, PTY `+10045`; `10393ms`: `phase=unknown`, PTY `+18081` |
| positive control | FIRED at `10900ms`, `phase=working`, PTY `+18971`, no trust/hooks modal |
| interrupt call | at `10901ms`, response `{"ok":true}` |
| after 6s | `phase=idle`, PTY delta `+771` from interrupt point, assistant delta `0` |
| after 12s | `phase=idle`, PTY delta `+771`, assistant delta `0` |
| final row | `phase=idle`, `idle.kind=interrupted`, summary `turn aborted`, `workingMsTotal=10726` |
| transcript marker | `event:'interrupt'` absent (`false`) |
| app-server previews | `0` (legacy PTY route) |

The accepted interrupt, stable 6s/12s output, and final `idle.interrupted` row
show that the legacy turn stopped. The transcript marker remained absent.

One earlier legacy attempt was also discarded: its interrupt raced at `545ms`
while the observed row was still `phase=unknown`; the call returned
`{"ok":false}` with the expected “not working right now” refusal, and the turn
was still `phase=working` at 12s. It is not included in the baseline reading.

### Epic contrast

POD-3038's scored epic Codex run at `38a2d1a` bound
`codex-app-server`/`server`, fired on `8` live preview frames while
`phase=working`, and accepted `sessions.interrupt` with
`{"ok":true,"requested":"protocol"}`. The turn left `working` in `536ms`,
but no transcript item carried `event:'interrupt'`. The epic cell was
therefore recorded as `PARTIAL` under its clause-level matrix.

The valid main fallback independently reproduces the marker absence, but it
does not provide an exact app-server A/B because main cannot bind that driver.

## Disposition

The two valid readings above are the only main-arm baselines reported for this
issue. The no-control A3 app-server attempt and the early-race legacy attempt
were discarded under the positive-control rule. The calibrated A6b scrollback
instrument could not measure corruption versus repaint on either arm; no
additional scrollback instrumentation was available for this drive.

`docs/plans/pod-1761-results.tsv` was not edited. The coordinator should
transcribe the two verdicts and retain the exact-driver caveats.
