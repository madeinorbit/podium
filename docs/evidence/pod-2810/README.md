# A claude terminal session showing as idle for its whole turn

*POD-2801's rig found this while fixing a different harness and could not say
whether the hooks were never delivered or were delivered and rejected. They were
delivered — and the daemon threw the important one away before the observer ever
saw it. This is that, driven down to the mechanism and fixed.*

Same rig, same instrument, same arm as POD-2801 — this directory adds only the
readings. Repin it on **this** worktree, or it measures someone else's code:

```bash
P2801_REPO="$PWD" P2801_DRIVER=claude-pty bash docs/evidence/pod-2801/drive-up.sh

. docs/evidence/pod-2801/drive-env.sh
PODIUM_PASSWORD=p2801 PODIUM_RUNTIME_DRIVER=claude-pty \
  P2801_READY_MS=45000 bun docs/evidence/pod-2801/phase-probe.ts claude
```

`drive-env.sh` is sourced, never executed, and the probe reads its `PODIUM_PORT`
and `PODIUM_PASSWORD` from the environment — run the probe without it and the
default is **19847**, which is POD-2777's live instance and not this rig at all.

| | before | after |
|---|---|---|
| claude / `claude-pty` | **FAIL** — `idle`×60, 79,922 bytes over 53 of 59 growing intervals | **PASS** — `working`×60, 72,413 bytes over 59 of 59 |

Readings in `readings/`. The before column reproduces the filed reading in every
field, down to the durable checkpoint it leaves behind: cursor
`{transcript: 0, hook: 0}`, `lastAcceptedLiveCursor: null`, `turnEpoch: 0`, and a
transcript segment pinned at `device: "missing", inode: "missing"`.

## THE MECHANISM — the one hook that opens a turn, dropped for being early

`apps/daemon/src/hook-ingest.ts` logs nothing per request, so the first step was
a temporary counter there and at every `return null` on the fold path. The trace
it produced is `readings/instrumented-hook-trace.txt`, and it settles the open
question in four lines:

```
P2810 ingest    hook=UserPromptSubmit  psid=e78d1346-…  tpath=…/e78d1346-….jsonl
P2810 applyHook-capture-FAILED  hook=UserPromptSubmit  path=…/e78d1346-….jsonl
P2810 applyHook hook=Stop  boundary=54568  dev=2049  ino=1369023
P2810 observeHook-reject  no-open-epoch  Stop promptId=46b57201-…
```

**Claude never posts `SessionStart`.** Podium registers the hook and claude 2.1.231
does not fire it, so the first hook a fresh session delivers is its
`UserPromptSubmit`. That hook therefore does double duty: `startClaudeCausal`
consumes it as the bootstrap, and buffers it to be replayed as the live hook once
the server acks — which is the design, and the bootstrap even snapshots the
pre-signal side of the boundary on purpose so "the buffered provider hook owns
the sole live working edge".

**At that instant the transcript file does not exist yet.** Claude has not created
`~/.claude/projects/<slug>/<id>.jsonl` when it posts its first prompt hook. So the
bootstrap's `captureClaudeTranscript` throws, the `locateClaudeSessionFile` sweep
finds nothing, and the fallback capture pins the segment at
`device: "missing", inode: "missing"`, offset 0. That part is survivable — the
observer knows how to rotate onto a real segment later.

**What was not survivable is the replay.** `applyClaudeHook` treated a capture
failure as *drop this hook*, and the file was still missing when the buffered
prompt came back round. `UserPromptSubmit` is the only hook that opens a turn
epoch, so the epoch stayed closed and the phase stayed at the bootstrap's `idle`.

**Then everything after it was correctly refused.** The `Stop` that arrived minutes
later did capture cleanly (boundary 54568, a real device/inode) and was rejected
by the observer for having no open epoch — `Stop` is deliberately not one of the
`EPOCH_REVIVING_HOOKS`, because a terminal must not be able to manufacture a turn
that was never seen to start. The one legacy `agentState` frame the daemon sent
was rejected at the server as a legacy unfenced observation, which is also correct
for a session holding a causal checkpoint. Nothing here misbehaved except the drop.

## THE FIX — an unreadable transcript costs the hook its POSITION, not its existence

The hook is claude's own report of a lifecycle event and is evidence on its own.
The transcript supplies two things the fold can do without: a cursor boundary and
prompt-record evidence. `ClaudeCausalObserver` already had a defined answer for
having neither — `nextHookOffset` falls back to the last accepted offset — so the
fix is to stop discarding the hook and use it:

- `apps/daemon/src/session-observers.ts` — a failed capture yields `null` instead
  of an early return; the segment id and prompt evidence are simply omitted.
- `packages/harness/src/agent-state/claude-code.ts` — `nextHookOffset` takes
  `number | null` so "no boundary to offer" is a value rather than a `NaN` trick.

With no segment id passed, the observer keeps the segment the bootstrap fenced and
advances only the hook plane of the cursor, which is exactly what makes the
observation strictly after the checkpoint: `{transcript: 0, hook: 0}` →
`{transcript: 0, hook: 1}`. The first hook that *does* capture then rotates onto
the real segment naming that one as its predecessor, and the server's
`compareProviderCursor` accepts it. `readings/full-turn-both-edges.txt` shows the
whole chain running: `working` at +1s, `idle` at +3s, terminal fence `done` on
epoch 1, and the segment moving off `missing` onto device 2049 at offset 38730.

## WHY THE SUITE WAS GREEN

Every pre-existing causal test in `session-observers.test.ts` calls
`writeFile(transcript, '')` before the first hook. With the file present the
capture never fails, the drop never happens, and the defect is invisible — the
same shape POD-2801 recorded for opencode, where the sink the daemon always
passes was the one the tests never registered.

The regression test therefore does **not** create the file, and writes it only at
the point claude really does — just before `Stop`. It asserts the bootstrap
really is pinned at `missing/missing` (so the test cannot quietly stop exercising
the condition), that the replayed prompt opens the turn anyway, that
`acceptAgentObservation` would accept that observation against the bootstrap
checkpoint, and that the terminal rotates the segment onto a real device/inode
naming its predecessor. Against the unfixed daemon it fails on the missing
`turn_opened`.

## What this does NOT fix

**Claude not posting `SessionStart` is left alone.** It is upstream behaviour, the
bootstrap path handles its absence correctly, and with this change the first
`UserPromptSubmit` carries the session into a live turn regardless. Worth knowing
about; not worth working around here.
