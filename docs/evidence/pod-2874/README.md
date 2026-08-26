# POD-2874 Claude and shell acceptance

Release acceptance was driven on 2026-08-26 against checkout
6c10b6643a7c86f3d951216dcf029528ff50d671.
Only the claude and shell columns were driven; POD-2777 owns codex and opencode.

| Row | Claude | Shell | Positive control |
|---|---|---|---|
| A1a | PASS | PASS | Three idle sends landed and replied; the last send was required to pass. |
| A1b | FAIL | n/a | Claude busy-turn user prompt landed; reload user and reply also landed. |
| A1c | PASS | PASS | Baseline turn/echo landed before the dead-session refusal test. |
| A2a | PASS | n/a | Durable working-turn prompt landed and produced an in-flight signal. |
| A2b | PASS | PASS | Fresh session attached and reported an initial status. |
| A3 | FAIL | n/a | Durable prompt landed and the session was observed working before interrupt. |
| A4a | BLOCKED | n/a | Live attach/terminal/transcript evidence fired before permission probing. |
| A4b | BLOCKED | n/a | Live attach/terminal/transcript evidence fired before the second-answer probe. |
| A5 | PASS | n/a | Durable tool-test prompt landed and returned a tool transcript. |
| A6a | PASS | PASS | Native viewer attached and received terminal bytes before input/resize checks. |
| A6b | PASS | n/a | First chat turn and reply landed before chat/native switching. |
| A7a | PASS | PASS | Pre-restart Claude turn or shell echo landed before daemon restart. |
| A7b | PASS | n/a | Pre-hibernate turn and codeword reply landed. |
| A8 | BLOCKED | n/a | Logged-out Claude attached and produced a visible terminal surface. |
| A9 | PASS | PASS | Target process tree existed before kill and screen bytes were present. |
| A10 | n/a | n/a | Not applicable to these harnesses. |

## Red count

There are **2 reds**, both in Claude:

- **Claude A1b — FAIL, POD-2879.** The busy second send returned
  {"ok":true,"queued":true,"disposition":"queued"} but exposed no durable queue
  position (position=null, position field=false). After reload, the queued user
  turn and reply were present.
- **Claude A3 — FAIL, POD-2880.** sessions.interrupt returned
  {"ok":true,"requested":"keystroke"} and the transcript contained
  [Request interrupted by user], but the session remained working through the
  20.103-second observation window.

The three Claude blocks are not counted as reds:

- A4a and A4b raised no permission ask under the seeded auto-mode posture, so the
  answer-path assertions were not attributable.
- A8 displayed Not logged in — Run /login; completing external OAuth was outside
  this rig.

## Runtime and pin evidence

- Named instance: p2874; server 31178; distinct probe directory per cell under
  /tmp/pod-2874/probes/{claude,shell}-<row>.
- Derived state root: /home/mgw/.local/state/podium/p2874; derived Claude home:
  /home/mgw/.local/state/podium/p2874/agent-home.
- No PODIUM_STATE_DIR, PODIUM_AGENT_HOME, ABDUCO_SOCKET_DIR, TMUX_TMPDIR,
  PODIUM_WEB_DIR, or HOME override was used.
- Every reading records server, web, and daemon pins in readings/*.json and
  pins/*.json. Server and daemon boot stamps matched the full checkout SHA;
  the web bundle reported source SHA 6c10b66, wire digest
  3434afac488e513a, and bundle bundle+B_1436Qd.
- Every scored reading has control.fired=true. Memory readings taken before
  each cell are stored in each pin; cells were run serially.
- Claude used the normal claude-pty headed path. Shell used the normal
  product-derived terminal path after removing an invalid rig-only
  PODIUM_RUNTIME_DRIVER override.

The complete per-cell readings are in [readings/](readings/), with the launch
helpers in this directory.
