# A busy terminal session showing as idle

*POD-2777's acceptance drive measured 13,250 characters of output across 60
polls on the terminal arm with `agentState.phase` reading `idle` at every one.
This is what that was, driven down to a mechanism and fixed.*

```bash
bash docs/evidence/pod-2801/drive-up.sh                     # server + daemon, terminal arm
bun  docs/evidence/pod-2801/phase-probe.ts opencode codex grok

P2801_DRIVER=claude-pty bash docs/evidence/pod-2801/drive-up.sh   # claude's own terminal driver
P2801_READY_MS=45000 P2801_DRIVER=claude-pty bun docs/evidence/pod-2801/phase-probe.ts claude

bash docs/evidence/pod-2801/drive-down.sh
```

Instance `p2801`, port base 19877, state root `/tmp/pod-2801` — separate from
POD-2777's `p2777`/19847, which is usually up on this box and which this rig
must never read or disturb.

## THE CONTROL, because `idle` is often the right answer

A phase that reads `idle` for sixty seconds is CORRECT for a session that is not
doing anything: a TUI parked on a first-run dialog, a prompt that never landed,
an agent that answered in two seconds. So the probe reports nothing unless it
can show output was arriving at the time — and not merely that some bytes
existed, but that they kept coming: it counts how many of the 59 one-second
intervals saw MORE PTY output than the interval before. Under 5 and the reading
is **REFUSED**, never a FAIL.

That threshold is not decoration. On this rig's first pass codex scored 3,984
bytes and `unknown` at all 60 polls, and it looked exactly like a defect; the
bytes were a first-run modal painting once and the session never ran a turn. The
interval count is what tells a repaint from a turn, and it refused that reading.

**Why bytes and not the transcript.** The transcript plane is fed by the same
per-harness observer that feeds the phase on some arms — which is precisely the
code under suspicion. Using it as the control would let one broken thing vouch
for another. The PTY byte stream crosses none of that code: it is the child
process's stdout, mirrored.

## WHAT WAS MEASURED

Both columns at epic tip **c47650d**, same rig, same prompt, same probe. The
"before" arm is byte-identical to the tip apart from this rig's own files; the
"after" arm adds exactly one product file's change
(`packages/harness/src/agent-state/opencode.ts`). Raw output per run is in
`readings/`.

| harness | driver | before | after |
|---|---|---|---|
| **opencode** | `generic-pty` | **FAIL** — `idle`×60, 121,554 bytes, EVER working: **false** | **PASS** — `working`×12, 159,751 bytes |
| **codex** | `generic-pty` | REFUSED — 3,984 bytes over 0 growing intervals; the session never ran a turn | **PASS** — `working`×38, 91,041 bytes |
| **grok** | `generic-pty` | **PASS** — `working` then `errored`, 9,132 bytes | REFUSED — the account hit its weekly limit; the phase correctly read `errored` |
| **claude** | `claude-pty` | **FAIL** — `idle`×60, 79,242 bytes over 49 of 59 growing intervals | unchanged here — a DIFFERENT defect, fixed on POD-2810, see below |
| cursor | `generic-pty` | not driven — `cursor-agent` is not installed on this box | — |

The before/after reading for opencode, in the probe's own words:

```
before   +  1249ms  phase=idle     ptyBytes=   7806
         + 12018ms  phase=idle     ptyBytes=  95687
         + 22522ms  phase=idle     ptyBytes= 118151   transcriptChars=6453
         phases seen: idle=60        EVER working: false

after    +  1136ms  phase=idle     ptyBytes=   7894
         + 11425ms  phase=working  ptyBytes= 110823
         + 21655ms  phase=idle     ptyBytes= 156742   transcriptChars=6488
         phases seen: idle=48 working=12   EVER working: true
```

## THE MECHANISM — two readers, one cursor

`observeOpencodeState` polls opencode's SQLite store every ~700ms. Two functions
read from it and BOTH advance the same cursor:

- `emitTranscript` — reads the message parts newer than `(lastPartTime,
  lastPartId)`, publishes them as transcript items, and moves the cursor.
- `tick` — reads the message parts newer than `(lastPartTime, lastPartId)`,
  turns each row into a state event (`prompt_submitted` for a user text part,
  `activity` for a text/tool part, `turn_completed` for `step-finish`), and
  moves the cursor.

`pollOnce` ran them in that order, so on every tick of every turn the transcript
read consumed the new rows and the state read then queried from a cursor already
past all of them. `loadOpencodeMessageParts` is a strictly-after query, so it
returned zero rows, `events` stayed empty, `onEvents` was never called, and the
reducer was never reached. The phase kept whatever `bootEvents` seeded — `idle`
— for the entire turn, which is why the transcript filled up (6,453 characters
arrived) while the phase never moved a millimetre.

The fix is one reader per cursor. `tick` publishes the SAME cursor-stamped items
on `onTranscriptItems` that `emitTranscript` would, so it is the reader that
keeps both planes; `emitTranscript` is kept only for the initial tail load,
which `tick` does not do, and only while that load is still owed. History is
deliberately not replayed as live `activity`: `bootEvents` already classifies the
prior turn, and re-announcing it would restamp a finished session as busy.

**`onTranscriptItems` is the whole reason this survived a test suite.**
`emitTranscript` returns immediately when no transcript sink is registered, so an
observer constructed without one never starves its own state read and the bug is
invisible. Every pre-existing test in `opencode.test.ts` passes `onEvents` alone;
the daemon always passes both. The regression test added with the fix registers
both sinks and asserts the state plane sees the same rows the transcript plane
does, with the transcript arrival as its control — so a reappearance of the
starvation cannot be reported as "the rows never came".

This is the catalogue's `wired` column doing exactly what that column warns
about: the code existed, the tests passed, and driven it did not work.

## THE SECOND DEFECT, found by this rig and fixed on POD-2810

**Claude on `claude-pty` never reports `working` either, for a completely
different reason.** 79,242 bytes of output across 49 of 59 growing intervals,
12,267 transcript characters, and `phase=idle` at all 60 polls.

Claude's phase does not come from a poller at all — it comes from `type: "http"`
hooks folded by the causal observer. Three things are established:

1. **The harness does fire them.** Claude 2.1.231 was run directly against a
   throwaway HTTP sink using the same settings shape Podium writes, and it
   posted `UserPromptSubmit` and `Stop`. So the events exist.
2. **The bootstrap was accepted.** The server holds an observation checkpoint
   for the session naming the real provider session id, so *a* hook arrived and
   was folded. This section originally read "so `SessionStart` arrived";
   POD-2810's trace showed claude fires no `SessionStart` at all, and what
   bootstrapped the session was its first `UserPromptSubmit`.
3. **Nothing live was ever accepted after it.** That checkpoint's cursor reads
   `components: {transcript: 0, hook: 0}`, `lastAcceptedLiveCursor: null`,
   `turnEpoch: 0` — through a turn that wrote 79KB. Its transcript segment was
   pinned at bootstrap as `device: "missing", inode: "missing"`, because claude
   had not created the transcript file yet when that first hook fired; the file
   exists now, 57KB of it.

And the one legacy `agentState` frame the daemon did send for that session was
**rejected at the server** — `"rejected a legacy unfenced observation"` — which
is correct policy for a session holding a causal checkpoint, and means the
session had no second channel to fall back to. That is the "produced and
dropped" shape worth naming: on the causal path, a live channel that stops being
accepted goes silent rather than degrading.

Whether the live hooks were never delivered or were delivered and rejected
against that bootstrap cursor was the open question. **POD-2810 answered it and
fixed it: they were delivered, and the daemon dropped the one that mattered.**
Claude fires no `SessionStart` at all, so a fresh session's first hook is its
`UserPromptSubmit` — which becomes the bootstrap AND is replayed as the live
hook. At that instant claude has not created the transcript `.jsonl`, so the
capture threw and `applyClaudeHook` returned without folding. `UserPromptSubmit`
is the only hook that opens a turn epoch, so the epoch stayed closed and the
`Stop` that arrived once the file existed was correctly refused for having no
open epoch. The fix makes an unreadable transcript cost the hook its position
rather than its existence. Re-driven on this rig: `working`×60 over 59 of 59
growing intervals. See `docs/evidence/pod-2810/`.

## What this rig deliberately does NOT do

**No web bundle.** POD-2777's rig builds one because its verdict is about the
product an operator opens in a browser. This one measures a single field of the
session row over the API the board reads it from, so the bundle is not on the
path and building it would add minutes to every repin. If a later question is
about what the board RENDERS rather than what it is served, this is the wrong
instrument.

**It pins the driver per arm, and says so.** The terminal family has two
drivers. Pinning `generic-pty` machine-wide makes a claude spawn fail outright
with *"runtime driver 'generic-pty' is not wired for harness 'claude-code'"* —
which reads in a probe's output as a session that produced nothing rather than
as a rig that asked for the wrong driver. This rig's first claude pass did
exactly that, and the fix is `P2801_DRIVER=claude-pty`.
