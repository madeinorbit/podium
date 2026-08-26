# Tier-A release matrix — driven on a rig with no overrides

Instance `p2777`; server + daemon + web bundle verified at the same commit before
every run. Two phases: `15cdfa0`/`6685c59` before POD-2853 landed, and `6685c59`
with the fix in. 2026-08-26.

---

## The headline

**Two cells where the new drivers are WORSE, both P1, and one of them is
ordinary work.**

**POD-2885 — long turns wedge on `codex-app-server`** (filed by me as POD-2884,
top-level; POD-1761 re-filed it under the epic as POD-2885, which carries the
work). **Re-confirmed on the merged tip `372ae4d`, after main was merged in: 426
seconds at `working`, previews frozen at 80, zero transcript characters, never
completes — so it is present on the branch that would actually ship, not only on
the pre-merge epic.** One prompt, three arms:
headless runs 422 seconds at `working`, freezes its preview plane after ~20s,
writes *zero* transcript characters and never completes. The terminal driver
completes the same prompt in 61s with 12,291 characters. Codex run directly,
outside Podium, completes it in 83s. So the work finishes outside Podium and on
the old driver, and wedges only on the new one.

**POD-2875 — a delivered message is destroyed.** Under a declared CLI view a chat
send returns `{"ok":true,"disposition":"delivered"}` and parks; restart the daemon
and it is gone for good, while the session stays healthy. The same probe on
`generic-pty` delivers it normally.

Two cells say headless is **better** — A1a at 4.1s against 6.4s, and the
provider-error row where headless surfaces a failure in 12.2s that terminal never
surfaces at all. Two say it is worse, both in expensive ways.

**And removing the rig's path overrides was worth it on its own.** With them gone
this rig runs the way an ordinary named installation runs, and that immediately
blocked the whole terminal column — POD-2853's socket path composed to 121 bytes
against a 107-byte limit, and no named instance could fit *regardless of its
name*. Fixed and landed; my measurements are why the fix moved the socket root
instead of trimming it, and why its budget takes the attach label rather than the
session label.

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

**33 cells driven.** Claude and shell are POD-2874's columns; grok unassigned.
H = headless arm, T = terminal arm.

| # | drive | codex H | codex T | opencode H | opencode T |
|---|---|---|---|---|---|
| A1a | send while idle | **PASS** 4.1s | **PASS** 6.4s | ☐ | **PASS** 7.8s |
| A1b | send while busy | **PARTIAL** | ☐ | **PARTIAL** | ☐ |
| A1c | send to a dead session | **PASS** | ☐ | **PASS** | ☐ |
| A2a | status while working | **PASS** | ☐ | ☐ | ☐ |
| A2b | status at boot | **PASS** | ☐ | **PASS** | ☐ |
| A3 | interrupt mid-turn | **REFUSED** | ☐ | ☐ | ☐ |
| A4a | permission ask | **BLOCKED** | ☐ | **PARTIAL** | ☐ |
| A4b | answer twice | **BLOCKED** | ☐ | **PASS** | ☐ |
| A5 | transcript | **PASS** | ☐ | **PASS** | ☐ |
| A6a | terminal attach + type | **PASS** | **PASS** | **PASS** | **PASS** |
| A6b | chat↔CLI twice | **PASS** | **PASS** | **PASS** | **PASS** |
| A7a | daemon restart | **PASS** | ☐ | ☐ | ☐ |
| A7b | hibernate + wake | **PASS** | ☐ | ☐ | ☐ |
| A8 | logged-out spawn | ☐ | ☐ | **PARTIAL** | ☐ |
| A9 | kill session | **PASS** | ☐ | ☐ | ☐ |
| A10 | driver identity | **PASS / PARTIAL** | ☐ | **PASS** | ☐ |
| — | long turn completes | **FAIL** | **PASS** 61s | **FAIL** | **PASS** 92s |
| — | parked turn survives restart | **FAIL** | **n/a** | ☐ | ☐ |

**FIVE DISTINCT DEFECTS IN THE PRODUCT**, appearing in more cells than that:

| | defect | where |
|---|---|---|
| P1 | POD-2885 — long turns wedge | codex H **and** opencode H; both terminal arms fine |
| P1 | POD-2875 — delivered message destroyed by a restart | codex H; reproduces on opencode H |
| | POD-2862 — one permission opens two asks | opencode H |
| | POD-2870 — no queue position for a chat caller | codex H **and** opencode H |
| | A3 unmeasurable until POD-2885 is fixed | codex H |

Plus **POD-2895**, which was the *merge* rather than the product: the main merge
left `TranscriptFeed.tsx:621` unparseable, so no rig on the epic could pin its
three components. The same hunk had also deleted the queued bubble's body, so a
syntax-only fix would have compiled and rendered an empty bubble — the compiler
points at the last thing the splice broke, the parents show what it deleted.
Fixed at `aad84ec21`; I corroborated it with an independent full build (exit 0)
and a parse sweep that went to zero broken files across all 236 changed files.

**The two columns agree everywhere they overlap.** Every defect found in codex and
re-driven on opencode replicates; nothing yet distinguishes them. That is the
answer to "do the harness columns behave alike" so far, and it means a red found
in one column should be assumed present in the others until driven.

## What is left, exactly

My scope is codex + opencode: 16 rows x 2 columns = **32 cells**.

| | cells | |
|---|---|---|
| driven | **26** | codex 15/16, opencode 11/16 |
| never driven | **6** | codex A8; opencode A2a, A3, A7a, A7b, A9 |

Of the driven cells, **A3 is REFUSED** rather than scored — its control needs the
turn observed in flight, and both planes are frozen by then, so it is
unmeasurable until POD-2885 is fixed. **A4a/A4b are BLOCKED on codex**: that
harness raises no approval on this host, controlled against codex run *outside*
Podium with the same flag, so it is the harness and not the product.

Applying POD-1761's file-level analysis of the main merge rather than re-running
everything:

| | what | why |
|---|---|---|
| re-drive | codex column, headless cells | `codex-app-server.ts` moved |
| re-drive | A1a, A1b, A5 on both columns | ten session-module files moved |
| leave | opencode driver cells | `opencode-server.ts` did not move |
| leave | A6a, A6b terminal arm | `generic-pty` did not move |
| done | the POD-2885 wedge | already re-confirmed at the merged tip |

New *defects* can now only come from those six never-driven cells. A re-drive
turning red would be a regression the merge introduced — a different and more
alarming finding than a new defect, and worth reporting as such.

---

## Predictions for the six undriven cells, recorded BEFORE driving them

Written down while blocked on the heavy-work lock, so that when these run the
results are falsifiable rather than rationalised afterwards. Where a prediction
is wrong, that is the interesting outcome and it will be reported as one.

| cell | prediction | why |
|---|---|---|
| opencode **A3** interrupt | **REFUSES**, same as codex | its control needs the turn observed in flight; opencode wedges the same way (POD-2885), so both planes are frozen by the time the control samples. If it instead SCORES, the wedge is not identical across harnesses and that matters to POD-2885. |
| opencode **A2a** status while working | **PASS** | codex passed with 51 preview frames; opencode's preview plane demonstrably works for its first ~20s before the wedge. A2a and the wedge are the same behaviour at different timescales. |
| opencode **A7a** daemon restart | **PASS** | codex passed; opencode's resume path is exercised by A7b already. |
| opencode **A7b** hibernate + wake | **PASS** | it passed on codex and POD-2775 fixed opencode's adopt path specifically. |
| opencode **A9** kill session | **PASS** | codex passed; the kill path is shared, not per-driver. |
| codex **A8** logged-out spawn | **PARTIAL**, same as opencode | the demotion should be declared (`condition`, `requestedDriverId`, `loginRequired`) with no login affordance on the session, because the missing affordance is a contract-level gap the catalogue already declares absent — not a per-driver one. |

Five of six predict the columns keep agreeing. **The one I would most like to be
wrong about is opencode A3**: if it scores where codex refuses, the two wedges
differ in a way POD-2885 needs to know.

Two of these six are timing-sensitive (A2a, A3) and will be driven **last**, with
host load and swap stated alongside the result.

---

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

### The headline cell — a parked turn is lost, and only on headless

```
HEADLESS (codex-app-server)
  sent under a declared native view -> {"ok":true,"disposition":"delivered"}
  after 45s     0 transcript items, 0 deltas, nonce absent, phase idle    C1 parked
  daemon restart  pid 2156779 -> 2163850, reconnected                     C2 real restart
  afterwards, chat view declared:  parked turn arrived = FALSE, 0 items
  a FRESH turn on the SAME session: answers fine                          C3 session healthy

TERMINAL (generic-pty), one variable changed
  sent under a declared native view -> {"ok":true,"disposition":"delivered"}
  after 45s     2 transcript items, 2 deltas, nonce PRESENT, phase idle
```

The probe **refuses** to score the terminal arm — with nothing parked there is
nothing whose survival could be measured — and that refusal is the finding:
`generic-pty` does the right thing under exactly the conditions where
`codex-app-server` parks and then loses the message. Three outcomes are reported
separately (LOST / SURVIVED / INCONCLUSIVE) so "the session died" can never be
read as "the message was lost".

*A correction I made against myself:* I first filed this as a reporting defect
and offered it as waivable, because I had watched the parked turn drain when a
chat view was declared. That drain only works if nothing restarts in between.
The restart question — which POD-1761 asked for — turned a reporting defect into
data loss.

### A6a and A6b — the two cells that were blocked, now green on both arms

```
A6a codex/headless   3998 bytes on attach; echo; resize repaint 1854B each way;
                     second viewer 3264B, 10/11 shared tail lines incl. the typed mark
A6a codex/terminal   5812 bytes; 12/12 shared lines
A6b both arms        epoch stable at 0 across four switches; scrollback marker
                     survived every one; geometry stable; chat AND CLI both work after
```

The arms differ in one recorded way: the **headless** arm adds three processes per
CLI switch (`abduco -n podium-cx-attach…`, `codex resume …`, `abduco -a …`) and
tears them down again; the **terminal** arm adds none. That is the client
cold-start the catalogue already declares absent for server drivers — recorded,
not scored.

*Two more corrections against myself, both on A6b.* I counted the attach client
as the agent and reported "no restart: false"; two attempts to separate them by
command-line pattern both failed, because the client runs the same binary with
the same `--listen` shape. The census is now taken while **chat** is declared,
when no view process exists at all — behaviour, not pattern-matching. And neither
terminal-view probe primed the TUI: on headless there is no TUI in the way so the
omission never showed, and the first terminal run reported "chat stopped
answering" over 599,437 bytes of a dialog repainting.

---

### The long-turn wedge — three arms, one prompt

```
A. HEADLESS (codex-app-server)                 WEDGES
   t+11s  working  previews=29  transcriptChars=0
   t+21s  working  previews=77  transcriptChars=0    <- preview plane freezes here
   t+31s..t+422s   previews=82  transcriptChars=0    <- 400s, not one more frame
   FINAL  working  items=1 (the user message only). Never completes.

B. TERMINAL (generic-pty), one variable changed  COMPLETES in 61s
   screenBytes 30468 -> 90393 growing throughout, then idle, transcriptChars=12291

C. CODEX DIRECTLY, OUTSIDE PODIUM, same binary   COMPLETES in 83s
   exit 0, 31,065 bytes, runs to "400 — The number 400 is an integer."
```

*A control failure worth recording rather than dropping:* my first attempt at arm
C was invalid — `codex exec` was waiting on stdin and timed out at 420s having
produced 39 bytes. Had I not read the output I would have concluded "codex stalls
outside Podium too" and closed the finding. The 83s figure is the re-run with
stdin closed.

This also explains **A3**. The interrupt probe's control requires the turn
observed in flight immediately before the interrupt — previews growing or
transcript growing. On headless both are frozen by then, so the control cannot
fire and A3 correctly refuses. Re-driven alone on a clean session to rule out the
shared streaming turn; it refused identically.

### A8 — logged-out spawn, and a wrong FAIL I had to take back

The probe first reported **FAIL**: "a logged-out opencode SILENTLY became a
generic-pty session", i.e. a POD-2772 regression. **It is not silent.** I had
checked `agentState.error`, `spawnFailure` and `status`, found nothing, and
concluded the product said nothing. Dumping the *whole* row showed it says it
plainly:

```
condition:          "logged-out"
requestedDriverId:  "opencode-server"   beside   driverId: "generic-pty"
accounts.list:      loginRequired: true
machines.list:      login.state: "out"
```

"The product says nothing" is a claim about *every* surface, and it cannot be
made from the two you happened to read. Corrected to **PARTIAL**: the demotion is
declared as requested-versus-actual and the account readout asks for a login, but
`interactions.list` is empty — nothing on the session offers to log you in. The
catalogue already declares that gap (`login(harness, method)` absent). The second
half of the row — "after login, the next session lands on the server driver" — is
**not driven**, because a real OAuth login would either mint credentials this rig
must not mint or rotate the operator's own token mid-release.

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
