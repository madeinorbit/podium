# Tier-A release matrix — first drive on a rig with no overrides

Instance `p2777`, commit `15cdfa0`, server + daemon + web bundle all verified at
that commit before every run. 2026-08-26.

---

## The headline

**Removing one line from the rig blocked the entire terminal column of the
release matrix, and it was the right thing to happen.**

Every rig on this epic — this one included — set `ABDUCO_SOCKET_DIR` to a short
path under `/tmp`. POD-1761 ordered that removed (POD-2856's rule: a rig may not
shorten or relocate a path the product picks). With it gone, this rig runs the
way an ordinary named installation runs, and on that configuration:

- **no terminal-driver session starts at all** — `spawnFailure: "abduco exited 1:
  create-session: File name too long"`;
- **the native CLI view never appears on the headless drivers either**, and there
  it fails *silently*: the session stays `live`, `spawnFailure` stays `null`, the
  attach is answered normally, and the pane is simply blank forever.

That is POD-2853, and the previous matrix headline — "headless better in three
cells, worse in one" — was measured on a configuration that hid it.

The chat plane is unaffected and is where the driven cells below come from.

---

## What changed in the rig

| removed | what the product picks instead |
|---|---|
| `PODIUM_STATE_DIR=/tmp/pod-2777/state` | `~/.local/state/podium/p2777` (`instanceStateDir`) |
| `ABDUCO_SOCKET_DIR=/tmp/pod-2777/abduco` | `<state>/runtime/abduco` (`applyInstanceRuntimeEnv`) |
| `TMUX_TMPDIR=/tmp/pod-2777/tmux` | `<state>/runtime/tmux` |
| `HOME=<agent-home>` on the daemon | the real `HOME`; a named instance already isolates the agent home by itself (`resolveAgentHomeDir`, config.ts:550) |

The daemon's `HOME` override was the subtlest of the four and only became visible
once `PODIUM_STATE_DIR` was gone: for a named instance the state root is *derived
from `$HOME`*, so a daemon under a different `HOME` lands on a **different state
root than the server** — here `…/p2777/agent-home/.local/state/podium/p2777`, the
path nested inside itself. It failed loudly only because that directory already
had files in it. On an empty one the daemon would have booted happily onto a
private state root while the rig believed it shared the server's.
`PODIUM_STATE_DIR` had been papering over that the whole time.

Two guards were added so this cannot silently come back:

- `state-root-check.ts` refuses the run if any of the three variables is set, or
  if the rig's computed state root disagrees with `instanceStateDir()`. Verified
  both ways: passes clean, exits 2 under an injected override and under an
  injected path drift.
- The daemon-identification in `drive-verify.sh` and the teardown in
  `drive-down.sh` now match on `PODIUM_INSTANCE`, not on a state path. The old
  spelling would have matched *nothing* once the variable was gone — a verify
  that fails every daemon, and a teardown that silently stops tearing down.

---

## The matrix as it stands

Sixteen rows × five columns = 80 cells. **14 cells driven, on 2 of 5 columns.**
The table says what was measured, not what is expected to hold.

| # | drive | claude | codex | grok | opencode | shell |
|---|---|---|---|---|---|---|
| A1a | send while idle | ☐ | **PASS** | ☐ | ☐ | ☐ |
| A1b | send while busy | ☐ | **PARTIAL** | ☐ | ☐ | n/a |
| A1c | send to a dead session | ☐ | **PASS** | ☐ | ☐ | ☐ |
| A2a | status while working | ☐ | ☐ | ☐ | ☐ | n/a |
| A2b | status at boot | ☐ | **PASS** | ☐ | ☐ | ☐ |
| A3 | interrupt mid-turn | ☐ | ☐ | ☐ | ☐ | n/a |
| A4a | permission ask | ☐ | **BLOCKED** | ☐ | **PARTIAL** | n/a |
| A4b | answer twice | ☐ | **BLOCKED** | ☐ | **PASS** | n/a |
| A5 | transcript | ☐ | **PASS** | ☐ | ☐ | n/a |
| A6a | terminal attach + type | ☐ | **BLOCKED** (H+T) | ☐ | ☐ | ☐ |
| A6b | chat↔CLI twice | ☐ | **BLOCKED** | ☐ | ☐ | n/a |
| A7a | daemon restart | ☐ | **PASS** | ☐ | ☐ | ☐ |
| A7b | hibernate + wake | ☐ | ☐ | ☐ | ☐ | n/a |
| A8 | logged-out spawn | ☐ | ☐ | ☐ | ☐ | n/a |
| A9 | kill session | ☐ | **PASS** | ☐ | ☐ | ☐ |
| A10 | driver identity | n/a | **PASS / PARTIAL** | ☐ | ☐ | n/a |

All cells are the **headless** arm unless noted. ☐ = **not driven** — no claim
either way. **The entire terminal column is blocked**: no terminal-driver
session starts. Grok stays REFUSED on its 402, per POD-1761.

**Seven PASS, three PARTIAL, three BLOCKED, nothing FAILED, 66 cells untouched.
This is not a release verdict and must not be read as one.**

Two rows fall short of their own criterion and are filed:

- **A1b** — the message is queued, survives a real reload and runs when the
  session goes idle, but **no position reaches the chat caller** on the return or
  on any socket frame. `POD-2870`.
- **A4a** — the chat half is clean, but one permission opens **two** asks on a
  server driver. `POD-2862`. (The row's terminal half is separately blocked.)

## The cells that were driven

### A1a — send while idle · codex · headless · **PASS**

```
BOUND DRIVER   codex-app-server (family server)
SENT           Reply with exactly this word and nothing else: PODIUM-UWDA2E.
SEND ACCEPTED  {"ok":true,"disposition":"delivered"}
REPLY          arrived after 9132ms
ASSISTANT TEXT 13 chars: "PODIUM-UWDA2E"
control        FIRED — 2 transcriptDelta frames; prompt echoed on transcript
```

A blank session cannot produce that nonce by luck.

### A7a — daemon restart · codex · headless · **PASS**

```
PLANT          "CODEWORD-BJQX4N" → replied "OK" in 5608ms
conversation   conv_0974dda8-be5e-4994-9abc-eae861126edc
RESTART        daemon pid 1772726 → 1783873, reconnected
AFTER          status live, driver codex-app-server
conversation   conv_0974dda8-be5e-4994-9abc-eae861126edc   ← identical
transcript     kept the pre-restart exchange
RECALL         "CODEWORD-BJQX4N" in 5096ms
```

Three controls, all fired: the codeword was planted, **the daemon pid actually
changed**, and the recall turn was delivered. Both the codeword *and* the
conversation pointer are checked — POD-2775's reviewer found that mutating a
resume to a stranger's thread id left 269 tests green, so a codeword alone is
too weak a signal.

**Mutation-checked, both restored byte-identical:**

| mutation | result |
|---|---|
| recall checks a codeword that was never planted | **FAIL** (was PASS) |
| restart script reports the same pid — nothing restarted | **REFUSED**, control C2 |

### A4a — permission ask · opencode · headless · **PARTIAL**

Chat half **PASS**: the ask is enumerable via `interactions.list` while open (not
only on the stream), carries a typed payload (`toolName=bash`,
`canAlwaysAllow=true`), is answerable with `allow-once`, and answering resolves
it and lets the tool run exactly once.

Terminal half **BLOCKED**: the row requires the same ask in the terminal and
answering to resolve *both*. The native terminal is never hosted on this rig.
**A chat-only pass is not an A4a pass**, so the cell is PARTIAL, not PASS.

One blemish, filed as **POD-2862**: a single permission opens **two** asks — the
protocol's structured one, and a `screen-classifier` copy that has no screen to
classify on a server driver and carries the whole shell command line in its
`toolName` field. Answering the real one does not clear the copy.

### A4b — answer twice · opencode · headless · **PASS**

Second answer returns `{"ok":false,"reason":"already-answered"}`; the tool did
not run again (1 file before, 1 after).

*A correction I made against myself:* the probe originally demanded a **thrown**
error and scored this as FAIL. The row asks for "a typed error, not a double
action" — a discriminated result carrying a machine-readable reason is typed, and
requiring a particular transport for the typing is a requirement the row never
made. The widening is fenced: the classifier is run against the **first** answer
too and must call it *not* a refusal, so it cannot degrade into "anything
counts". That control fired (`the FIRST answer classifies as: not a refusal`).

### A4a/A4b — codex · **BLOCKED**, with a control

Codex raises no approval at all: its app-server child runs with
`sandbox_mode="workspace-write"` and wrote to `$HOME` without asking.
**Control:** codex does exactly the same *outside Podium*, same flag, same host —
so this is the harness on this box, not Podium's ask plane. Reported BLOCKED, not
FAIL.

(Also cost a run: the first target was under `/tmp`, which codex's
`workspace-write` sandbox already permits. Outside the cwd is not the same as
outside the sandbox.)

### A6a — terminal attach and type · codex · **BLOCKED on both arms**

**Terminal arm** — loud:

```
status        exited        exitCode -1
spawnFailure  /home/mgw/.local/state/podium/p2777/bin/abduco exited 1:
              create-session: File name too long
label         podium-p2777-2591ded6-bfe5-42d7-965b-80d99fd9916f
```

**Headless arm** — silent, and this is the worse shape:

```
status        live          driverId codex-app-server
spawnFailure  null          exitCode null
attached      {"resumed":false,"outputSeen":false,"epoch":0,
               "geometry":{"cols":120,"rows":40}}
terminal bytes in 25s: 0
```

The client is told the attach **succeeded**. The cause reaches no client surface
at all — only the daemon log has it:

```
[warn] pty:abduco     systemd scope unavailable; session will NOT survive a podium restart
                      label=podium-cx-attach-28651e0a-…  (53 chars)
                      err=systemd-run exited 1: create-session: File name too long
[warn] daemon:host    could not host a Codex client terminal
[warn] daemon:session could not attach the native client terminal
```

The probe **refuses** rather than reporting "keystrokes did not echo": a silent
screen and a session that never had a terminal are different findings, and the
control cannot tell them apart. `outputSeen=false` is the product's own agreement
that the terminal has printed nothing since spawn — the exact signal the
catalogue (`driver-capability-catalog.md:278`) says is needed to distinguish
"attached but silent" from "lost the replay window".

*A correction I made against myself:* the first version of this probe never sent
the `viewState` frame the browser sends, so the server was never told any view
was open. Reporting a blank terminal without it would have been a rig bug wearing
a finding's clothes. Adding it changed nothing about the verdict — but it had to
be added before the verdict could be trusted.

---

### A1b — send while busy · codex · headless · **PARTIAL**

```
CONTROL        phase reached 'working' in 587ms  (the probe refuses otherwise)
second send    {"ok":true,"queued":true,"disposition":"queued"}
position       ABSENT from the return AND from every frame on the socket
               (turnPreview=15 sessionAgentStateChanged=2 transcriptDelta=2
                attached=1 welcome=1 machinesChanged=1 approvalsChanged=1
                hostMetricsChanged=2 presenceRoomState=1 presenceRoomDelta=1)
reload         websocket closed and reopened — the message survived
delivered      the queued turn ran and answered with its nonce
```

*A correction I made against myself:* the first scoring was `delivered &&
saysQueued → PASS`, which silently dropped the two words "with position" from the
row. Not losing a message and being able to say **where in the queue** it is are
different promises. Filed as POD-2870 — and the position is not missing by
accident: `command-plane.ts:459` narrows the chat reply to four pinned keys, with
a comment deferring the wire change.

### A1c — send to a dead session · codex · headless · **PASS**

```
CONTROL        a send to this session WHILE ALIVE was answered
after kill     the row is gone entirely
send to dead   {"ok":false,"reason":"dead-lettered: session no longer exists",
                "disposition":"dead_letter"}
```

A typed refusal naming the situation, and the forbidden outcome — silent
acceptance into a black hole — did not occur.

### A2b — status at boot · codex · headless · **PASS**

Sampled from the moment of creation rather than once at the end, because the row
is a claim about the whole window and a late sample cannot see a session that
spent its first seconds saying `working`:

```
t+   253ms  status=starting  phase=(blank)  driver=(none)
t+  2406ms  status=live      phase=idle     driver=codex-app-server
```

Never `working` before use; never blank once a driver was bound.

### A5 — transcript · codex · headless · **PASS**

```
tool Bash    toolUseId: true   result: true   "TRANSCRIPT-BF81OQ\n"
reload       live had 4 items; a fresh socket was served 4; 0 missing
             the nonce is still in the reloaded history
```

*A correction I made against myself, and the one that would have done the most
damage.* The first version looked for a following item with role `tool_result`,
found none, and scored **A5 FAIL — "tool calls paired to results: false"**. That
would have gone into this report as a product defect. The real shape carries the
call and its output on the **same** item (`toolInput` + `toolResult` +
`toolUseId`, with `text` empty). I dumped the raw items rather than trusting my
own verdict. The item shape is now declared in `rig.ts` so the next probe reads
it instead of guessing. `toolUseId` is checked too — a result with no id to tie
it to a call satisfies "a result is present" while pairing nothing.

### A9 — kill session · codex · headless · **PASS**

```
CONTROL   2 processes appeared for this session, attributed by /proc environment:
            codex app-server …            141MB
            /bin/sh /usr/bin/lsb_release  (a grandchild the agent spawned)
KILL      sessions.kill → row gone entirely
          0 of 2 alive after 15s
          0 orphans after 300s
          2/2 rig infrastructure processes still alive
```

Every number from `/proc`, attributed by environment — never by command-line
pattern, since other instances on this box run identically-named binaries and a
`pkill -f codex` would take the operator's own sessions down while reporting a
clean sweep. The session row's opinion is recorded but never the verdict, because
the row says "check the process table, not the UI".

*A correction I made against myself:* the first run drove `sessions.stop` and
reported PASS. The tree was gone, so the observation was true — but stop came
back `status=hibernated stopReason=parent`, which is a **park, not a kill**. A
park that tidies its processes says nothing about whether a kill does. Re-driven
against `sessions.kill`; the verb is now a parameter and the report names it.

### A10 — driver identity · codex · **PASS / PARTIAL**

Half one **PASS**: `driverId=codex-app-server`, `driverFamily=server`.

Half two **PARTIAL**: under `PODIUM_RUNTIME_DRIVER=generic-pty` — read back out
of the *running* daemon's `/proc/<pid>/environ`, so it is the daemon's arm and
not a script's intention — the session did **not** bind a server driver. It took
the abduco path and died there. The escape hatch demonstrably demoted; what
cannot be read is the demoted session's reported identity, because POD-2853 stops
it surviving long enough to report one.

---

## Three measurements sent to POD-2853

1. **No named instance can fit, regardless of its name.** Measured by running the
   vendored abduco directly at the product's own default paths:

   | id | composed path | bytes | abduco |
   |---|---|---|---|
   | `a` (shortest legal) | `…/podium/a/runtime/abduco/abduco/mgw/podium-a-<uuid>@flatblock` | 113 | File name too long |
   | `p2777` | … | 121 | File name too long |
   | `operator` | … | 127 | File name too long |
   | `default` | `~/.abduco/podium-<uuid>@flatblock` | 71 | **exit 0** |

   The budget, derived and then matched against all three measurements exactly:
   the constant part is 90 bytes, so `HOME + 2·len(id) + len(user) + len(host)`
   must be ≤ 17. With `mgw`+`flatblock` that leaves `HOME + 2·len(id) ≤ 5` — a
   one-character id needs a `HOME` of 3 bytes. `len(id)` appears **twice**: once
   in the directory, once again in the label prefix.

2. **The headless path has the same defect with less rope.** `codex-app-server`'s
   socket is `…/podium/<id>/runtime/codex-app-server-sockets/<12hex>-<12hex>.sock`
   — 94 constant bytes. Measured by binding real unix sockets: **107 binds, 108
   fails**. So any instance id longer than 13 characters loses the codex headless
   driver too, and `INSTANCE_ID_PATTERN` allows 32.

3. **On the headless arm it is completely silent**, and the client-terminal label
   (`podium-cx-attach-<uuid>`, 53 chars) is *longer* than the session label (49),
   so the native view overflows by 4 more bytes than the spawn does. Whatever
   budget lands has to clear the longer one. The first warning also blames the
   wrong thing — a hard start failure reported as a durability warning about
   restarts.

---

## What this drive does and does not show

**Does:** the chat plane holds up on the headless drivers on an ordinary named
installation. A turn answers with its nonce; a conversation survives a real
daemon restart with its pointer intact; a fresh session reports idle from
2.4 seconds; a send to a dead session is refused in words rather than swallowed;
a busy session queues and then delivers; the transcript pairs tool calls to their
results and a reload serves the same history; a kill leaves no process behind
after five minutes; and a permission ask is enumerable, typed, answerable and
idempotent.

**Does not:** answer the operator's question. Sixty-six of eighty cells are
undriven, the terminal column cannot be driven at all until POD-2853 lands, and
without that column there is no A/B — and "better" is a comparison. The previous
run's side-by-side stands only for the configuration it was taken on, which is
not one anybody ships.

**The release rule is "zero Tier-A fails".** Nothing here has FAILED. But three
cells are *blocked* and three are *partial*, and under a rule with no waiver row
neither is a pass. Two of the partials are filed (POD-2862, POD-2870); all three
blocked cells are one issue (POD-2853).

**Four self-corrections, listed together because the pattern matters more than
any one of them.** Each was a verdict this drive was about to publish, caught by
checking the mechanism instead of the number: the probe that asked for a terminal
without telling the server a view was open; the one that demanded a thrown error
where the row asked only for a typed one; the one that scored a park as a kill;
and the one that scored a correct transcript as FAIL because it guessed the item
shape. Three of the four would have been reported as product defects.
