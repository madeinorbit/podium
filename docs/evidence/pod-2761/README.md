# POD-2761 — switching to CLI redraws the interface into the last one's scrollback

The operator resumed a codex session with several exchanges in it, sent a message
in Chat, switched to CLI, and got the whole codex interface twice in sequence —
header, messages, input box, footer, then the same again below.

This directory holds the rig that drives that switch and the record of what it
found. The short version: the coordinator's proposed mechanism was half right,
and the half that was wrong is the half that decides the fix.

## The scripts

| file | what it does |
| --- | --- |
| `drive-env.sh` | isolation environment for the `p2761` instance — source it, never execute it |
| `drive-up.sh` | brings up server + daemon, split and detached, from this worktree |
| `drive-verify.sh` | **refuses to let you measure anything** until the running processes are proven to be the commit you name |
| `drive.ts` | the drive: three exchanges, Chat→CLI→Chat→CLI, process topology + rendered screen |
| `drive-down.sh` | stops the pair, keeps the state and logs |

```
bash docs/evidence/pod-2761/drive-up.sh
bash docs/evidence/pod-2761/drive-verify.sh HEAD
bun  docs/evidence/pod-2761/drive.ts codex
```

Re-cut from `docs/evidence/pod-2753/`, with two deliberate reversals — see
"What this rig had to unlearn from 2753" below.

## What was established

**Codex cold-starts on every view switch — confirmed.** Chat→CLI→Chat→CLI on a
live codex session, watching the abduco master and client:

| | first CLI | Chat | second CLI |
| --- | --- | --- | --- |
| codex | 2903272, 2903281 | *nothing alive* | 2904001, 2904004 |
| opencode | 2905222, 2905224 | *nothing alive* | 2905504, 2905519 |

**Opencode cold-starts too — the coordinator's split is not real.** The reading
under test was that opencode parks its abduco master with a 30-minute idle
window, so bouncing between views is a reconnect, and only codex pays for a cold
start. The second row above says otherwise, and one line explains it: the release
arm calls `clientTerminals.close()` for *every* server-family session and only
varies the `kind` argument — but `close()` reclaims `record.label` whatever
`kind` says, because `kind` is consulted only when there is **no** record. On a
release straight after an attach there is always a record. The warm window and
the whole `watched`/`arm` machinery never get to apply to a view switch at all.

The existing tests already encode this without saying it out loud:
`session-native-client.test.ts:104` asserts `close` **is** called (with
`undefined`) for the non-codex case. No test asserts that a master survives; the
`close` port is a stub in all of them.

**The fresh client does NOT lose the conversation.** `codex resume` replays it.
Capturing the client's own bytes across a switch and rendering them brings back
all three planted exchanges — ALPHA, BRAVO and CHARLIE. So "only the newest
exchange" is not the cold start losing history. That half of the report is not
yet reproduced, and is not explained by the mechanism proposed for it.

**What does explain the duplicate.** The browser terminal is addressed by
*session*, not by attachment (POD-2108), so one stream outlives every client
generation. The server truncates its replay log only on a frame carrying a screen
reset (`SCREEN_RESET`, `apps/server/src/modules/sessions/terminal.ts`). Across a
full switch, **zero** clears reached the view. So generation two's interface
lands below generation one's — in the live view, and again in the replay that
every later attach rebuilds from. Rendered through the browser's own emulator, a
real capture shows the residue as stacked banner borders above the current
interface.

## What the drive did NOT establish — read this before trusting the fix

**The A/B is null.** Driven on `p2761` against a live codex session, the rendered
buffer holds exactly one interface *with* the fix and exactly one *without* it:

| build | client pids, round 1 → round 2 | interfaces in the buffer | conversation |
| --- | --- | --- | --- |
| with the fix (`a30481002`) | 3127390/3127393 → 3128571/3128580 | 1 | ALPHA, BRAVO, CHARLIE |
| fix reverted (`87e4b9911`) | 3137138/3137141 → 3138625/3138628 | 1 | ALPHA, BRAVO, CHARLIE |

So this rig reproduces the *mechanism* — a new client process per switch, on both
builds — but **not the operator's symptom**. The codex TUI usually emits its own
`ESC[2J`/`ESC[3J` on startup, which re-anchors the replay log and hides the
duplicate; the residue only showed up in a hand capture where it did not.

That makes the fix **defensible but unproven against the report**. It closes a
real hole — nothing in Podium guarantees the clear, and the whole duplicate
depends on the harness happening to emit one — but nobody should describe it as
"verified against what the operator saw".

**The one condition still untested is theirs exactly: a RESUMED session.** The
drive now hibernates and resumes before switching, and that path is blocked by a
different defect — `sessions.hibernate` on a codex app-server session leaves the
driver wedged (`server-reap: could not complete the server-driver verb`, then
`needs measured escalation`), the resume never comes back live, and the drive
measures nothing. Reproduced on two independent instances. Filed separately; it
has to be fixed before this symptom can be reproduced or the fix judged.

## The fix

Not "park it too" — the revoke-on-release behaviour protects a real hazard and is
untouched. Instead, a cold start stops *looking* like a continuation: a client
generation announces itself with cursor home + clear screen + clear scrollback,
emitted **before** the spawn so no frame of the generation it introduces can
precede it. The pair matches the server's own `SCREEN_RESET`, so the replay log
re-anchors there too and a later attach rebuilds from one interface.

One place, both surfaces, and harness-agnostic — which it has to be, because
opencode cold-starts as well.

## What this rig had to unlearn from 2753

**abduco stays real.** 2753's env points `$PODIUM_ABDUCO` at a path that does not
run, to force headless turns off the durable backend. Copying that wholesale here
would delete the subject: a client terminal *is* an abduco master
(`podium-cx-attach-<session>`).

**Credentials for the harness under test.** The first run of this drive printed
`the interface appears 0 time(s) — PASS` against a session that never started a
client terminal. Codex was logged out in the isolated agent home; a logged-out
harness does not fail loudly, it resolves to `generic-pty` behind a single warn
line, and an empty stream contains no duplicates. The rig now seeds codex
credentials, and — more importantly — **refuses to report any verdict** unless a
client-terminal process was seen *and* its interface reached the stream. An
absence of duplicates is evidence only when something could have duplicated.

`drive-verify.sh` also compares process **start time** against the commit's,
which is the leg a `cwd` check misses. It caught a stale pair the first time it
ran.

## What a screenshot would not have shown

The drive replays the captured bytes through `@xterm/headless` — the headless
build of the emulator the browser renders with — and reads the resulting buffer,
**scrollback included**. "The whole interface appears twice" is a claim about the
buffer; a screenshot shows only the viewport. What this is *not* is a person
looking at a browser. That check belongs to the operator, and this rig exists to
make it worth their time.
