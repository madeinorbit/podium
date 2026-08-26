# Grok acceptance drive

POD-2877 drove the Grok column on 2026-08-26. The ledger describes this as 15
rows, but the Tier-A table contains 16 named rows (A1a through A10); all 16
were driven on both arms, serially, with a free-memory check before each cell.

## Matrix

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

### Tier-B spot checks

| Spot check | H | T | Result |
|---|---|---|---|
| Provider error names the quota reason | BLOCKED | BLOCKED | No authenticated Grok turn could be created; no provider error was scored |
| OOM-killed session is not shown as finished | BLOCKED | BLOCKED | No safe OOM injector was used; a raw SIGKILL would not prove OOM classification |

## Red count

**FAIL reds: 0.** There were no scored FAIL cells, so no product-red issue was
filed from this drive. There are **2 PARTIAL attention cells** (A8 H and T) and
**30 BLOCKED Tier-A cells** (the other 15 rows on both arms). The Tier-B spots
are both BLOCKED on both arms. If the release dashboard treats PARTIAL as red,
the attention count is 2; the strict FAIL-red count is 0.

At drive time no usable Grok authentication was available: `/home/mgw/.grok/auth.json`
was absent and no `XAI_API_KEY` was present. The operator subsequently confirmed
that Grok is out of quota until **2026-08-27 11:03 CEST**; this lane is deferred
until then, not treated as a product-red finding. The login path itself was
observed; no browser/device-code login was performed, and the restored-session
claim was not rounded up to PASS.

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

## Credential-only re-drive

The rig is ready for a re-drive once quota returns. From this worktree, with
the operator's normal HOME inherited and no state/socket/HOME override:

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

The acceptance harness and isolated rig are [`grok-drive.ts`](grok-drive.ts)
and [`grok-rig.sh`](grok-rig.sh).
