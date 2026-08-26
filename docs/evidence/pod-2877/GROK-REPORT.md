# Grok acceptance drive

POD-2877 drove the Grok column on 2026-08-26. The ledger describes this as 15
rows, but the Tier-A table contains 16 named rows (A1a through A10); all 16
were driven on both arms, serially, with a free-memory check before each cell.

## Initial unauthenticated drive matrix

H is the normal headless policy arm; T is the explicit
`PODIUM_RUNTIME_DRIVER=generic-pty` terminal arm.

| Row | Criterion | H | T | Positive-control / reason |
|---|---|---|---|---|
| A1a | Idle send arrives as `sent`, never silently settles | BLOCKED | BLOCKED | H bound `generic-pty`/terminal instead of `grok-acp`; T showed the logged-out login screen before its cell control could fire |
| A1b | Busy send queues with position, survives reload, delivers idle | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A1c | Dead-session send refuses or offers resume; never loses text | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A2a | `working` within 2s, `idle` after, no flicker | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A2b | Fresh idle session shows idle, not working/blank | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A3 | Interrupt stops the turn and records why | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A4a | Permission card and terminal ask agree; one answer resolves both | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A4b | Second answer is a typed error, not a double action | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A5 | Tool calls pair with results and reload preserves history | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A6a | Attach/type echoes, resize refits, second viewer agrees | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A6b | Chat→CLI→chat→CLI twice; both views remain functional | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A7a | Daemon restart keeps the same conversation and recall | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A7b | Hibernate/wake preserves context and does not wedge | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A8 | Login path works; next session uses the server driver | PARTIAL | PARTIAL | Positive control fired: native output showed `Approve in your browser to finish signing in` plus a device code. No credential was available to complete login; the next session remained `generic-pty` |
| A9 | Kill removes the process tree with no orphan server | BLOCKED | BLOCKED | Same H binding mismatch; T logged out before the cell control |
| A10 | Default is server-family Grok; explicit generic-pty demotes it | BLOCKED | BLOCKED | H never bound `grok-acp`; T was logged out, so neither arm had the authenticated control required for this comparison |

### Tier-B spot checks — initial pass

| Spot check | H | T | Result |
|---|---|---|---|
| Provider error names the quota reason | BLOCKED | BLOCKED | No authenticated Grok turn could be created; no provider error was scored |
| OOM-killed session is not shown as finished | BLOCKED | BLOCKED | No safe OOM injector was used; a raw SIGKILL would not prove OOM classification |

## Authenticated follow-up — the three requested checks

The operator supplied the normal Grok credential after the initial drive. The
follow-up deliberately drove only the newly measurable cells; it did not retry
the ordinary turn-dependent rows while Grok's quota was exhausted.

| Check | H | T | Positive control and observed evidence |
|---|---|---|---|
| A8 post-login half — fresh session lands on the server driver | **PASS** | n/a for this half; the explicit terminal arm is the A10 demotion comparison | H binding receipt fired independently of model output: `driver=grok-acp family=server` |
| A10 driver identity | **PASS** | **PASS** | H reported `grok-acp` / `server`; T reported `generic-pty` / `terminal` under the explicit override. Both binding controls fired without a turn. |
| Tier-B provider error names the quota reason | **PASS** | **PASS** | H returned `usage_limit`, `retryable:false`, `API error (status 402 Payment Required): Grok Build usage balance exhausted`. T accepted the send and its native screen showed `Weekly limit left: 0%`; the neutral-token recheck excluded probe text from the vocabulary assertion. |

The A8 H result completes that arm's original PARTIAL: its earlier login-path
control fired, and the authenticated fresh-session binding now passed. The
original A8 T cell remains **PARTIAL**: its login-path control fired, while the
explicit `generic-pty` arm is intentionally not a server-driver arm; that
server-family comparison is scored by A10.

## Post-merge confirmation — release tip

After the release merge landed at `7b9d9eacb`, this branch was rebased onto the
local epic ref and `git merge-base --is-ancestor 7b9d9eacb HEAD` passed. The
served web bundle was rebuilt, and the same three requested checks were driven
again on H; A10 and the quota spot-check were then driven on T. No other rows
were retried.

| Check | H | T | Positive control and observed evidence |
|---|---|---|---|
| A8 post-login half | **PASS** | not scored on the explicit terminal comparison arm | Fresh H binding receipt: `driver=grok-acp family=server`; control fired independently of model output. |
| A10 driver identity | **PASS** | **PASS** | H: `grok-acp` / `server`; T: `generic-pty` / `terminal` under the explicit override. Both controls fired. |
| Tier-B provider error names the quota reason | **PASS** | **PASS** | H again exposed `usage_limit`, `retryable:false`, and `API error (status 402 Payment Required): Grok Build usage balance exhausted`. T again showed `Weekly limit left: 0%` after the delivered neutral-token probe. |

The post-merge H boot used server PID 2752963 and daemon PID 2753224; the T
boot used server PID 2757475 and daemon PID 2757804. Every scored result pinned
both processes to `ac391d07c23aba33ac1fe6c40c390c33d1929941` and the web bundle to
`ac391d0`, with the same named instance and no product-derived-path overrides.
The post-merge memory readings were 1982–2816 MiB on H and 2356–3444 MiB on T.

## Red count

**FAIL reds: 0.** There were no scored FAIL cells, so no product-red issue was
filed. The current record has **1 PARTIAL attention cell** (A8 T) and **28
BLOCKED ordinary Tier-A cells** (the other 14 rows on both arms). A8 H is now
PASS; A10 is PASS on both arms. The provider-error spot-check is PASS on both
arms; the OOM spot-check remains BLOCKED on both arms. If the release dashboard
treats PARTIAL as red, the current Grok attention count is 1; the strict
FAIL-red count remains 0.

The initial drive had no usable Grok authentication: `/home/mgw/.grok/auth.json`
was absent and no `XAI_API_KEY` was present. That is the distinct logged-out
cause for the original H/T BLOCKED cells and A8 PARTIALs; H's policy binding
fell back to `generic-pty`, while T showed the device-code login screen. The
operator then supplied `/home/mgw/.grok/auth.json` (1738 bytes, mode 600) and
confirmed the account is out of quota until **2026-08-27 11:03 CEST**. The
quota exhaustion is a separate Tier-B observation, not a reason to reclassify
the ordinary rows as product reds.

No better/worse claim is made for the ordinary acceptance rows: they remain
unscored on both arms. The explicit H/T comparison is complete for A10 and the
quota spot-check.

## Pins and rig

Every cell recorded a fresh pin and memory gate in the raw readings. Both arms
used the named instance `grok2877`, one working directory per cell, and no
`PODIUM_STATE_DIR`, `PODIUM_HOME`, `ABDUCO_SOCKET_DIR`, or `HOME` override.
The derived state root was `/home/mgw/.local/state/podium/grok2877`; inherited
HOME was `/home/mgw`; the derived port was `30374`.

| Arm | Server PID / SHA at spawn | Daemon PID / SHA at spawn | Web source SHA | Driver | Memory gate range |
|---|---|---|---|---|---|
| H | 2468351 / `6c10b6643a7c86f3d951216dcf029528ff50d671` | 2492340 / `6c10b6643a7c86f3d951216dcf029528ff50d671` | `6c10b66` | policy (requested `grok-acp`, fallback `generic-pty`) | 2878–3887 MiB |
| T | 2513914 / `6c10b6643a7c86f3d951216dcf029528ff50d671` | 2514372 / `6c10b6643a7c86f3d951216dcf029528ff50d671` | `6c10b66` | `generic-pty` | 1288–4022 MiB |

The web bundle stamp was `apps/web/dist/podium-build.json`, source SHA
`6c10b66`. Final checks found zero Grok2877 probe sessions left behind.

The authenticated follow-up booted the current checkout at server/daemon SHA
`93e5312134ef67e53a16cefc6f82316fff7e6fab` and web source SHA `93e5312`:

| Follow-up boot | Server PID / SHA at spawn | Daemon PID / SHA at spawn | Driver | Memory gate readings |
|---|---|---|---|---|
| H — A8/A10/first provider | 2608657 / `93e5312134ef67e53a16cefc6f82316fff7e6fab` | 2609007 / `93e5312134ef67e53a16cefc6f82316fff7e6fab` | policy → `grok-acp` | 3970–4073 MiB |
| T — A10/first provider | 2635415 / `93e5312134ef67e53a16cefc6f82316fff7e6fab` | 2636509 / `93e5312134ef67e53a16cefc6f82316fff7e6fab` | `generic-pty` | 2944–3094 MiB |
| H — neutral-token provider confirmation | 2666194 / `93e5312134ef67e53a16cefc6f82316fff7e6fab` | 2666722 / `93e5312134ef67e53a16cefc6f82316fff7e6fab` | policy → `grok-acp` | 4317 MiB |
| T — neutral-token provider confirmation | 2670882 / `93e5312134ef67e53a16cefc6f82316fff7e6fab` | 2671196 / `93e5312134ef67e53a16cefc6f82316fff7e6fab` | `generic-pty` | 4219 MiB |

All follow-up pins retained the named instance `grok2877`, derived state
`/home/mgw/.local/state/podium/grok2877`, inherited HOME `/home/mgw`, and no
state/socket/HOME override. The rig is now down; its derived agent home retains
the copied credential, so a future drive needs only a valid credential/quota and
does not need to rediscover the isolation setup.

## Credential-only re-drive

The rig is ready for the remaining ordinary rows once quota returns. From this
worktree, with the operator's normal HOME inherited and no state/socket/HOME
override:

```sh
# Supply exactly one normal Grok credential, without printing it:
#   either /home/mgw/.grok/auth.json (the normal $HOME/.grok/auth.json),
#   or XAI_API_KEY in the environment below.

# Keep this shell alive for the runtime; on this host the acceptance launcher
# reaps descendants when a short command exits. Use a second shell for the
# runner after this command reports server and daemon PIDs.
bash docs/evidence/pod-2877/grok-rig.sh up headless; sleep 3600
env -u PODIUM_INSTANCE -u PODIUM_STATE_DIR -u PODIUM_HOME \
  -u PODIUM_WEB_DIR -u PODIUM_AGENT_RELAY -u ABDUCO_SESSION \
  -u ABDUCO_SOCKET -u ABDUCO_SOCKET_DIR \
  PODIUM_HOST=127.0.0.1 PODIUM_PORT=30374 \
  PODIUM_PASSWORD=grok2877 PODIUM_DRIVE_BASE=/tmp/pod-2877-grok \
  /home/mgw/.bun/bin/bun --conditions=@podium/source \
  docs/evidence/pod-2877/grok-drive.ts headless

bash docs/evidence/pod-2877/grok-rig.sh up terminal; sleep 3600
env -u PODIUM_INSTANCE -u PODIUM_STATE_DIR -u PODIUM_HOME \
  -u PODIUM_WEB_DIR -u PODIUM_AGENT_RELAY -u ABDUCO_SESSION \
  -u ABDUCO_SOCKET -u ABDUCO_SOCKET_DIR \
  PODIUM_HOST=127.0.0.1 PODIUM_PORT=30374 \
  PODIUM_PASSWORD=grok2877 PODIUM_DRIVE_BASE=/tmp/pod-2877-grok \
  /home/mgw/.bun/bin/bun --conditions=@podium/source \
  docs/evidence/pod-2877/grok-drive.ts terminal
```

`grok-rig.sh` derives `/home/mgw/.local/state/podium/grok2877` and copies the
normal-home `$HOME/.grok/auth.json` into its derived agent home at `up`; it
does not set HOME or any state/socket directory. `XAI_API_KEY`, when supplied
by the operator, is passed through to the daemon without being recorded. The
headless re-drive should bind `grok-acp`; the terminal command intentionally
binds `generic-pty` for the comparison arm. Every cell will re-check its own
SHA pin and memory gate.

The logged-out signature to distinguish from a still-blocked run is: the
daemon resolves requested `grok-acp` to `generic-pty` with reason
`harness is logged out; terminal provides interactive login`, and the native
screen says `Approve in your browser to finish signing in` with a device code
and `Waiting for approval`. A successful credential-only re-drive should not
show that signature and should produce authenticated positive controls.

Raw per-cell readings, including controls, memory, pins, session IDs, and A8
screen evidence:

- [`grok-headless.json`](readings/grok-headless.json)
- [`grok-terminal.json`](readings/grok-terminal.json)
- [`grok-terminal-server.log`](readings/grok-terminal-server.log)
- [`grok-terminal-daemon.log`](readings/grok-terminal-daemon.log)
- [`grok-followup-headless.json`](readings/grok-followup-headless.json)
- [`grok-followup-terminal.json`](readings/grok-followup-terminal.json)
- [`grok-followup-neutral-headless.json`](readings/grok-followup-neutral-headless.json)
- [`grok-followup-neutral-terminal.json`](readings/grok-followup-neutral-terminal.json)
- [`grok-postmerge-headless.json`](readings/grok-postmerge-headless.json)
- [`grok-postmerge-terminal.json`](readings/grok-postmerge-terminal.json)

The acceptance harness and isolated rig are [`grok-drive.ts`](grok-drive.ts)
and [`grok-rig.sh`](grok-rig.sh).
