# Claude Enter: measurements and recovery

Measured on 2026-10-04 for POD-5557, before changing production typing. **All
240 timing cases submitted or entered Claude's native queue. No natural
fast-Enter cutoff was reproduced.** Twenty additional consumer-pause cases also
submitted. Raising the existing 90 ms delay has no support in these results.

The native rule we could establish is about parser state: **a CR before the
bracketed-paste closing marker remains paste content; a plain CR after the
complete marker submits, including while Claude is busy.** An LF outside the
paste inserts a newline. Controlled faults reproduce the retained-input state;
the new recovery submits it with one extra CR and one original paste.

The historical failure's exact native key-handler state was not captured. The
controlled faults below establish behavior and recovery, not the cause of the
live incident. [Summary data](summary.json), [interactive evidence](evidence.html),
and the individual JSONL files preserve that distinction.

## Live incident: the first two copies survived

The user entry at transcript line 49907, timestamp
`2026-10-04T07:28:27.877Z`, contains **three copies** of the operator's message at
character offsets 0, 1851, and 2073. All are outside the two framed mail bodies;
these are not quotations inside mail. The first two copies are identical, 219
characters each. The third is 218 characters because one blank line differs;
all three have identical content after whitespace normalization.

This is positive evidence that the busy-time copies were retained and eventually
merged into the later prompt. They have no separate user or native queue entry.
Their absence as separate entries did not mean their text disappeared. The
final entry alone cannot assign each copy to a particular send time.

The redacted [transcript evidence](live-transcript-evidence.json) saves offsets,
frame ranges, and a normalized-content hash without copying the operator's
message or private mail. The [journal extract](live-journal.jsonl) saves only
timestamps, IDs, stages, and outcomes:

| Send | Requested (UTC) | First failed report (UTC) | Elapsed |
| --- | --- | --- | --- |
| `msg_6305757e` | 07:14:54.963 | 07:15:00.214 | 5.251 s |
| `msg_bedb81a4` | 07:19:52.085 | 07:19:57.090 | 5.005 s |
| `msg_30f1d500` | 07:26:22.947 | 07:26:28.153 | 5.206 s |

The journal's `prompt_queued` is Podium's runtime queue, not Claude's native
`queue-operation: enqueue`. These reports supplied no evidence that Claude had
submitted the input. No raw stdin/key-handler capture exists for these Enters,
so the journal cannot distinguish an incomplete paste, a newline key, or another
native input condition.

## Rig and isolation

[measure.ts](measure.ts) imports the production `createTerminalInjection`,
`injectionPayload` path, Bun PTY backend, and Claude screen classifier. It runs
the real installed CLI in a real PTY, feeds output and terminal replies through
headless xterm, and reads Claude's actual JSONL transcript. Its echo port polls
new records for each uniquely named fake prompt; it never accepts historical
setup entries as proof. The daemon wiring is covered separately by the focused
tests below.

Each run creates `/tmp/pod5557-<label>-*` with its own HOME, Claude config, cwd,
fake-server request log, raw output capture, and PID ledger. The child environment
is a whitelist: no real credentials, operator config, session hooks, or live
session identity. A visibly fake API key addresses only
[fake-model-server.ts](fake-model-server.ts) on loopback ports 45557 or 45558.
No real model was called. The rig refuses occupied ports, stops only its recorded
child/burner PIDs, and stops its own fake server by port after verifying the owner
PID. It does not use `pkill`.

Installed versions and binary hashes are in [binaries.json](binaries.json).
2.1.283 was copied from flatblock's installed binary into
`/tmp/pod5557-binaries/claude-2.1.283`; 2.1.289 was the newest locally installed
version. Neither binary was downloaded or upgraded for this measurement.

The fake server holds an actual streaming response, an actual Bash tool call
waiting for a scratch release file, or an actual `/compact` model response.
Each setup must reach the current native screen/request state before typing the
case. CPU-load runs pin Claude and four recorded Python busy loops to the same
first allowed CPU. The injector and fake server are not pinned.

## Timing matrix

For each version/load condition: four states × three body types × five delays
= 60 cases. Bodies are a short single line, four lines, and a two-line body with
1000 `x` characters plus its unique case ID. State results are confirmed by the
saved screen and native records, not merely by a mocked phase.

| Version | CPU contention | Idle | Streaming | Tool call | Compacting | Submitted/queued |
| --- | --- | --- | --- | --- | --- | --- |
| 2.1.283 | No | 15/15 | 15/15 | 15/15 | 15/15 | 60/60 |
| 2.1.283 | Four loops on Claude's CPU | 15/15 | 15/15 | 15/15 | 15/15 | 60/60 |
| 2.1.289 | No | 15/15 | 15/15 | 15/15 | 15/15 | 60/60 |
| 2.1.289 | Four loops on Claude's CPU | 15/15 | 15/15 | 15/15 | 15/15 | 60/60 |

| Requested paste-to-CR delay | Observed write-to-write range | Submitted/queued |
| --- | --- | --- |
| 0 ms | 1.067–19.890 ms | 48/48 |
| 30 ms | 30.068–69.785 ms | 48/48 |
| 90 ms | 90.116–135.391 ms | 48/48 |
| 200 ms | 200.119–276.709 ms | 48/48 |
| 500 ms | 500.134–564.738 ms | 48/48 |

Nominal zero uses the production timer port and therefore still schedules a
timer; it is not a synchronous CR write. The consumer-pause run SIGSTOPs only
the recorded Claude PID for 350 ms. Its 0/30/90/200 ms cases accumulate the paste
and CR before Claude resumes (16 cases); 500 ms adds four controls. All 20
submit. No claim is made about how many individual native `read()` calls occurred.

One early loaded case has `firstCRSubmitted: false` in its snapshot despite an
empty box: `ENTER-2.1.283-load-5-idle-short-500`. Its user entry was timestamped
185 ms after the first CR, before the rig's later manual CR. The receipt was
already accepted. This was observation lag, not a newline or lost Enter; the
rig now checks the input before manual recovery. The timestamp comparison is
retained in `summary.json`.

The complete matrix is assembled from:

- [2.1.283 idle](2.1.283-idle-probe.jsonl), [streaming/tool](2.1.283-busy.jsonl),
  [compaction](2.1.283-compacting-corrected.jsonl),
  [loaded idle/streaming/tool](2.1.283-load.jsonl), and
  [loaded compaction](2.1.283-compacting-load.jsonl).
- [2.1.289 normal](2.1.289-normal.jsonl) and [loaded](2.1.289-load.jsonl).
- The additional [consumer-pause cases](2.1.283-coalesced.jsonl).

An early compaction setup watcher mistakenly matched an older `/compact`
entry and cancelled the setup CR. Those contaminated cases were discarded and
rerun with a baseline per watch plus a current native compaction-state check.
They are not counted. Early runs sometimes saved a native enqueue before the
later user/queued-command entry; [settled-transcripts.jsonl](settled-transcripts.jsonl)
adds those later records from the same scratch sessions without rewriting the
original snapshots. All 240 matrix bodies ultimately have exactly one user or
queued-command entry. One extra consumer-pause case has native enqueue proof
only before its child was stopped.

## Paste-end rule and controlled missed Enter

Local inspection of 2.1.283's embedded JavaScript agrees with the PTY evidence:
the closing marker ends `IN_PASTE`; plain CR outside it becomes Return and calls
submit. LF becomes the newline key. The pending-paste handler defers Return
until its UI commit. Modifier/backslash continuation paths can insert a newline.
The reader's 50 ms incomplete-key timeout and 2000 ms unfinished-paste timeout
are not waits required after a complete closing marker. Binary offsets and
paraphrased rules are in [parser-notes.json](parser-notes.json).

Two explicit faults establish the retained-input behavior:

| Experiment | Initial Enter/result | Existing busy guard | Input-aware recovery |
| --- | --- | --- | --- |
| Replace first CR with LF, both versions | Newline; body remains in box | 0/6 verified; later manual CR submits the same paste | 24/24 verified, one extra CR, zero manual recovery |
| Hold closing marker until 100 ms after real CR | CR is paste content; no submission | 2.1.283 streaming: 0/1 verified; later manual CR submits | 2.1.289 idle/streaming, 0/90 ms delay: 4/4 verified |

LF recovery covers all four states and all three body types at 90 ms: twelve
cases per version. The 2.1.289 recovery run also uses CPU contention. These
faults deliberately change bytes or marker ordering at the PTY port; the normal
matrix always writes the complete production envelope before CR. No historical
claim that either fault actually occurred is implied.

Before recovery, native Claude displays retained text or a token such as
`[Pasted text #1 +3 lines]`, with no user or enqueue record. The added bare CR
clears the box and creates native proof for that one body. Every recovery case
has exactly one original paste and one native prompt; the analysis also checks
that no next prompt or `/compact` was merged into it. Screens, actual versus
intended bytes, timestamps, receipts, and records are in the
`*-missed-enter-{before,after}.jsonl` and `*-paste-end-{before,after}.jsonl` files.
The newest fault runs include a screen 150 ms after the first Enter, before the
automatic recovery tick.

The historical field `firstCRSubmitted` means **proof present in the snapshot
before manual recovery**. With retries enabled it includes automatic recovery;
it must not be read as proof that the first Enter worked. Actual Enter counts
and fault labels resolve that ambiguity.

## Production change

The first paste and 90 ms CR remain the measured path. When native proof has
not arrived at the 1600 ms verification tick, the driver reads the fresh shared
screen. It may send **one extra CR**, even while working or compacting, only if:

1. The box was empty immediately before this paste.
2. The current draft matches this body ignoring screen whitespace, or is one
   measured collapsed-paste token.
3. The host still holds its writer lease and its foreign-write count has not
   changed, including across the asynchronous screen flush.
4. No newer delivery on this injector has pasted another body.
5. No native proof, abort, or detach arrived during the screen read.

An empty or changed box receives no extra CR. A pre-existing draft, human edit,
lease loss, or overlapping send prevents ownership. The measured queued-message
hint is recognized as an empty input. Hosts without recognizable input evidence
keep their existing idle-only retry behavior. Adopted sessions without an
exclusive writer lease cannot claim a collapsed token for automatic recovery.
A previously identifiable box disappearing also prevents a blind retry, since
the native UI may have opened a dialog.

The body is never retyped by recovery. Clearing the box is not a receipt:
acceptance still requires Claude's native user/queue evidence. Unproven sends
remain unverified. This addresses the retained-input failure independently of
the historical Enter's uncaptured trigger; it does not establish a timing fix
for Codex's separately reported input behavior.

## Regression and mutant evidence

Work began from `dev/mw` at `04b2ff3f629832320c55ae2b0c6483174990385d`, with
`bun run setup:worktree` before measurements. Production typing was unchanged
through the full matrix and the first red regression.

Repository tests ran only on flatblock in `~/podium-test-5557`, a private
`git clone --shared ~/podium-timing` checkout. Its `.toolchain` was copied from
`~/podium-test-5556/.toolchain` without modifying that source; Bun is 1.4.2.
All test invocations used `bun run test:file`, foreground, named files only.

| Evidence | Executed result |
| --- | --- |
| Initial regression before production changes | 3 failed, 3 controls passed (6 tests) |
| One mutant: reject every retained-input recovery candidate | 5 failed, 9 controls passed (14 tests) |
| Restore mutant with `cp`, then final focused command | 322 passed in 5 files; 0 failures |

Backup and restored injector SHA-256 both equal
`21d6e9da70fff80d4cb13e2fcddc26b3736baff4bdf7be2baa6eb2bb36094992`.
[validation.json](validation.json) records the foreground runner results and
its exact footer. Its temporary JSON-report paths were removed by the wrapper;
they are provenance, not retained report files. This is focused evidence, not a
full-suite or lean-gate result.

```sh
cd ~/podium-test-5557
PATH="$PWD/.toolchain:$PATH" bun run test:file -- \
  packages/harness/src/driver/families/terminal/submit-recovery.test.ts \
  packages/harness/src/driver/families/terminal/terminal.test.ts \
  packages/harness/src/driver/families/terminal/runtime.test.ts \
  packages/harness/src/adapters/claude-code/state.test.ts \
  apps/daemon/src/runtime/submit-input.test.ts
```

The 15 recovery tests cover idle/working/compacting, the collapsed token,
bounded recovery without proof, cleared/changed/occupied input, foreign edits,
another paste, a disappearing box, and proof/writer changes during the read. Driver tests exercise
the actual host-to-injector wiring with and without a writer lease. The daemon
test reads its shared VT screen through real observers and the host port.

## Reproduce measurements

These commands run local measurements, not repository tests. Supply installed
binary paths with `--binary` when they differ. Use a fresh label to avoid appending
to existing evidence. The fake server is launched and cleaned up by the rig.

```sh
bun --conditions=@podium/source docs/measurements/pod-5557-claude-enter/measure.ts \
  --version 2.1.283 --binary /tmp/pod5557-binaries/claude-2.1.283 \
  --label fresh-283-normal
bun --conditions=@podium/source docs/measurements/pod-5557-claude-enter/measure.ts \
  --version 2.1.289 --load --label fresh-289-loaded
bun --conditions=@podium/source docs/measurements/pod-5557-claude-enter/measure.ts \
  --version 2.1.289 --states idle,streaming --bodies multiline --delays 0,90 \
  --retries --verify-input --fault-first-cr inside-paste --label fresh-paste-end
python3 docs/measurements/pod-5557-claude-enter/summarize.py
```

The analysis audits the committed canonical files: complete cell coverage,
one paste per case, native body equality, queue/prompt counts, and recovery
writes. It deliberately does not treat the discarded setup attempts as cases.
