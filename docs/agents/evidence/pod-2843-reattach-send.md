# POD-2843 — a reattached session and the send that "never arrives"

POD-2836 reported, while measuring something else, that typing into a
REATTACHED claude session after a server or daemon restart stopped reaching the
CLI: the row was typed five times to its attempt cap and no user turn ever
appeared. They offered it as a lead, explicitly unattributed, and said plainly
it might be the rig.

**It was the rig — and the rig fault is worth more than the bug would have
been, because it is also a shipped-product condition.** The readiness queue
delivers on both restarts. What produced the reported signature is a modal
`claude-code` wizard that a hermetic agent home makes appear, which Podium
cannot see and types five copies into.

## The rig

Isolated instance `PODIUM_INSTANCE=p2843` (state `/tmp/pod-2843`, ports
19877/46877/46878, loopback only), server and daemon split and detached under
Bun — the topology a real install runs, and the only one in which "restart the
server" and "restart the daemon" are different experiments. Re-cut from
`docs/evidence/pod-2773/`, itself POD-2245's recipe. Code under test is the
epic tip `a841ade74`; the server stamps `v=dev+a841ade-dirty` on every line.

Sessions are created over tRPC (`sessions.create`, cwd = a scratch git repo),
one fresh session per arm.

**Arrival is read twice, and that is the whole method.** "No user turn appeared
in the transcript" was read through the SERVER, and that single reading covers
two different bugs — the CLI never got the bytes, or the CLI got them and this
server cannot see the turn. So every send is checked against both the
`claude-code` CLI's own JSONL under the rig's agent home (parsed directly, no
Podium code in the path) and `sessions.read`. `attempts` is read straight out
of the server's own sqlite, because the attempt count is the reported
fingerprint and it should not be inferred from log lines.

Each arm's first send, BEFORE any restart, is a required positive control: if
it does not land, no verdict is printed and the process exits non-zero.

## What the rig produced before it was corrected

Two runs failed at that positive control, and both were `claude-code` modal
gates in front of an isolated agent home. Each swallows typed text, writes no
transcript turn, and leaves the session reporting `idle` — the exact signature
of the bug under investigation.

| gate | when it fires | fix |
| --- | --- | --- |
| folder trust — "Is this a project you created or one you trust?" | before the first turn in a cwd the HOME has never seen | seed `.claude.json` → `projects[cwd].hasTrustDialogAccepted` |
| `/auto-mode-setup` | the CLI runs it ITSELF once per session, as soon as that session's first turn ends, whenever auto mode is on and `~/.claude/settings.json` carries no `autoMode` block | seed a minimal `settings.json` with `permissions.defaultMode` and a non-empty `autoMode.environment` |

The second is the dangerous one and it is why this drive nearly reported a bug
that is not there. **It opens after the first turn**, so the obvious positive
control — "did my first send land?" — passes, and everything measured after it
is measuring the wizard. It also does not warm away: it fires in every new
session of such a home, so no number of warm-up turns clears it.

Neither was visible in any Podium reading. `sessions.status` said
`phase: "idle"` throughout. The only way to see either was the pane, read
through the product's own client websocket (`attach` → `outputFrame`).

With both seeded, `drive-warm.ts` puts three consecutive sends through one
session and all three land — 1/3, 2/3 and 3/3, the last two 3.3s apart.

## The two arms, on the corrected rig

Both start from a session that has already taken and confirmed one send, which
is the condition POD-2836 described. `PODIUM_TEST_WORKERS` is irrelevant here
(no vitest); times are milliseconds from the `sessions.sendText` call to the
user turn appearing in the CLI's own transcript.

| arm | send #1 (before) | send #2 (after the restart) | type attempts | copies the CLI took |
| --- | --- | --- | --- | --- |
| **server restarted** | 1214 | **1283** | 1 | 1 |
| **daemon restarted** | 1358 | **5634** | 1 | 1 |
| no restart (control) | 1160 | — see below | 0 | — |

Neither restart loses a send, and neither retypes.

**The daemon arm's 5.6s is the contract working, not failing.** A restarted
daemon reattaches a CLI that is already painted, so it produces no fresh output
to satisfy the quiet heuristic, and the send waits out the `READY_MAX_MS`
ceiling from the bind. That is exactly the conservative behaviour POD-2836's
own note predicted for an unproven composer. The server arm does not pay it
because the reattach redraw repaints the pane, and fresh output is what the
quiet branch is for.

**The control arm's `attempts: 0` is the load-bearing detail.** With no restart,
the session still holds its readiness proof, so `sendText` types directly and
never enters the queue. A restart clears that proof — `inputReadySessions` is a
`WeakSet` and does not survive a server restart, and `markSessionBound` clears
it on a daemon rebind — so a post-restart send goes through the readiness queue
instead, and the queue is the path with a five-attempt budget. **That is where
the reported "five times" comes from: not from the queue misbehaving, but from
the restart being what routes a send onto the retrying path at all.**

## The forgery arm

One variable, put back: the same server-restart arm with `settings.json`
removed from the agent home, which is the state POD-2836's rig was in and this
one was in for its first two runs.

| reading | corrected rig | forged rig (`settings.json` removed) |
| --- | --- | --- |
| send #1, disk | 1214ms | 1209ms |
| send #2, disk | **1283ms** | **NEVER** |
| send #2, server | 1331ms | NEVER |
| type attempts | 1 | **5** |
| copies the CLI took | 1 | **0** |

That is POD-2836's report, reproduced from one file's absence. Five attempts is
not a number the drive tuned for — it was PREDICTED before the arm ran, from
the reasoning above about which path a post-restart send takes, and predicting
the attempt count is what makes this a diagnosis rather than a coincidence.
Failing to arrive is cheap to produce by accident; arriving at exactly the
cap, on exactly the path a restart forces, is the report's fingerprint.

`copies the CLI took: 0` closes the other half. The bytes were typed five times
and the CLI's transcript holds none of them; the send-2 nonce does not even
appear on the pane, because the wizard consumes the keystrokes without echoing
them. So this is not silent duplicate delivery either — it is five writes into
a modal that answers to arrow keys.

## The verdict

**The reattach path is not losing sends, and the readiness queue is covering
the case it was built for.** Server restart and daemon restart both deliver, on
one attempt, one copy, against a session that had already taken a send.

The brief's first question — does a reattached session get a bind announcement
at all? — is **yes**, in both directions.
`apps/daemon/src/control/session.ts` sends `bind` from its already-held reattach
branch (the server-restart case, where the daemon survived) as well as from the
cold branch, and `daemon-lifecycle.ts` turns every `bind` into
`SessionInbox.markSessionBound` plus `drain(…, { justBound: true })`. The
unwitnessed-bind case POD-2836's note describes is therefore narrower than
feared: it needs a live row rehydrated at server boot whose daemon never
reattaches at all, which is not what a restart of either half produces.

## The gap that IS real, and it is not this issue's

Podium reported `phase: "idle"` for the whole forged run. Nothing in the
readiness contract can see a harness modal that is not the native
AskUserQuestion menu: `readinessQueueRefusal` refuses on
`agentState.phase === 'needs_user'`, and this wizard never sets it. So the
drain typed five copies into a dialog and then dead-lettered a row the operator
had every reason to think was delivered.

The condition is not confined to a rig. `resolveAgentHomeDir`
(`packages/runtime/src/config.ts`) gives every NAMED instance its own
`<state>/agent-home`, and nothing seeds a `settings.json` there — so on any
named Podium instance running claude-code 2.1.231 with auto mode, every session
opens `/auto-mode-setup` after its first turn, and the next send goes into it.
Filed separately; it could not be fixed here without changing what this issue
was asked to establish.

## Reproducing

```
bash docs/evidence/pod-2843/drive-up.sh          # server + daemon, split, detached
bun  docs/evidence/pod-2843/drive-warm.ts        # three sends must land before any arm runs
bun  docs/evidence/pod-2843/drive.ts server      # or: daemon, none
bash docs/evidence/pod-2843/drive-forge.sh server  # the report, reproduced from the rig
bash docs/evidence/pod-2843/drive-down.sh
```

## Gates

`bun run typecheck` plain — 25/25 successful. No source file changed, so there
is nothing for a per-file vitest run to cover and none is claimed;
`PODIUM_TEST_WORKERS` was unset throughout, and is irrelevant here because
nothing in this issue's evidence comes from vitest.
