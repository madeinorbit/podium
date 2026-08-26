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
| A4a | BLOCKED | n/a | Live control fired, but Claude 2.1.231 could not be seeded to suppress its wizard while retaining permission asks. |
| A4b | BLOCKED | n/a | Independent fresh-home run reached the same Claude 2.1.231 wizard/configuration limitation before the second-answer probe. |
| A5 | PASS | n/a | Durable tool-test prompt landed and returned a tool transcript. |
| A6a | PASS | PASS | Native viewer attached and received terminal bytes before input/resize checks. |
| A6b | PASS | n/a | First chat turn and reply landed before chat/native switching. |
| A7a | PASS | PASS | Pre-restart Claude turn or shell echo landed before daemon restart. |
| A7b | PASS | n/a | Pre-hibernate turn and codeword reply landed. |
| A8 | BLOCKED | n/a | Logged-out Claude attached and produced a visible terminal surface. |
| A9 | PASS | PASS | Target process tree existed before kill and screen bytes were present. |
| A10 | n/a | n/a | Not applicable to these harnesses. |

## Red count

Shell is clean: all 6 requested shell cells are PASS, with no shell reds.


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

- A4a and A4b raised no permission ask under fresh homes seeded for Claude 2.1.231.
  The live controls fired, but Claude rewrote the ask-preserving setting to auto or
  opened its own modal wizard, so the answer-path assertions were not attributable.
- A8 displayed Not logged in — Run /login; completing external OAuth was outside
  this rig.

## Follow-up: Claude A4 permission instrument

POD-1761 requested a re-drive with folder trust seeded in '.claude.json', a minimal
'settings.json', and permission prompts left intact. Claude Code was
'2.1.231 (Claude Code)'. Fresh named instances 'f' (A4a) and 'g' (A4b) used the
same clean 6c10b6643a7c86f3d951216dcf029528ff50d671 server, web bundle, and daemon.
The seed was:

~~~
{
  "permissions": { "defaultMode": "manual" },
  "autoMode": { "environment": ["### Release acceptance rig", "- isolated acceptance session"] }
}
~~~

Both controls fired with a live headed terminal (screenBytes 4297 and 4241),
but interactions.list stayed empty for 45.044s and 45.676s. Claude rewrote
permissions.defaultMode to auto in both homes; A4b also captured the
"Make auto mode your default permission mode?" wizard. The supporting readings are
[A4a](readings/followup-corrected-manual-claude-a4a.a4a.json) and
[A4b](readings/followup-corrected-manual-claude-a4b.a4b.json), with their pins in
pins/followup-corrected-manual-a4a-a4a.json and
pins/followup-corrected-manual-a4b-a4b.json.

As a control on the configuration hypothesis, fresh homes with
permissions.defaultMode: "default" and autoMode: {} also raised no ask: the
empty object left the wizard visible and was rewritten to auto after the typed
input. Together with the original non-empty-environment/auto-mode run, this shows
that Claude 2.1.231 exposes no settings-only seed that both suppresses its wizard
and preserves permission prompts. A4a/A4b are therefore **instrument BLOCKED**,
not product FAILs; exercising this path needs a different driver-level instrument
(for example an explicit manual launch mode) or a Claude-side configuration fix.

## Main comparison for Claude A3

The requested one-variable checkout comparison could not produce a main A3 verdict.
Today's local main is 0bd90092c3a926b9305da34547fcc51b1e19b0a7. On both a normal
named instance (p2874main) and the shortest legal one-character named instance
(a), main's server and daemon booted and pinned correctly, but the first Claude
spawn failed before the positive control with create-session: File name too long.
That is the pre-existing named-instance socket-path defect POD-2853, absent from
main and fixed by the epic tip. The mandatory no-override rule means
ABDUCO_SOCKET_DIR cannot be used to hide it, so main A3 is **BLOCKED / baseline
unavailable**, not PASS or FAIL. The two pinned attempts are recorded in
[main p2874main](readings/main-claude.a3.json) and
[main short-id](readings/main-claude-a.a3.json).

Consequently, the observed epic-tip A3 red (POD-2880) is not shown inherited by
main and is not shown to be an epic-only regression by this comparison; it remains
the incumbent-driver red already filed for the epic.

## Runtime and pin evidence
- The A4 follow-up pins use source root /tmp/pod-2867-codex-control and record
  the same full SHA for server and daemon plus the exact web stamp. The main A3
  comparison pins use source root
  /home/mgw/src/podium/.worktrees/issue-2856-run-every-test-rig-as-a-named-instance
  and full SHA 0bd90092c3a926b9305da34547fcc51b1e19b0a7.

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
