# POD-2919 opencode acceptance drive

This rig drove the ten cells assigned to the unowned opencode column. It used one
named instance (`oc2919`), one pinned web bundle, serial cells, and a distinct probe
CWD for every cell because opencode keys its store by CWD. Each reading records the
requested CWD, the CWD observed from the spawned process, the bound driver, the
server/daemon/web pins, a positive control, and disk/host snapshots.

The headless arm is the normal `opencode-server/server` binding. A10 also switched
the same named instance to `PODIUM_RUNTIME_DRIVER=generic-pty` and recorded the
deliberate `generic-pty/terminal` demotion.

## Recorded results

| Cell | Arm | Verdict | Evidence |
|---|---|---|---|
| A1a | headless | PASS | Delivered reply with durable user and assistant marker |
| A1b | headless | PARTIAL | Queued send survived reload and delivered; no queue position reached the caller |
| A1c | headless | PASS | Dead send returned a typed `dead-lettered: session no longer exists` refusal |
| A2b | headless | PASS | Bound `opencode-server/server`; boot timeline settled idle |
<<<<<<< HEAD
<<<<<<< HEAD
| A3 | headless | PARTIAL | Under load1=7.47 with vmstat quiet, interrupt stopped the turn in 632ms; transcript had no `event:interrupt` marker |
| A5 | headless | PASS | Tool calls/results paired by `toolUseId`; reload had no missing history items |
=======
| A3 | headless | PASS | Load1=7.47 with vmstat quiet; interrupt settled in 632ms; no transcript interrupt marker |
| A5 | headless | PASS | Two tool items paired by `toolUseId`; reload had no missing items |
>>>>>>> ca1a74892 (pod-2919 summarize final ten cells)
=======
| A3 | headless | PARTIAL | Under load1=7.47 with vmstat quiet, interrupt stopped the turn in 632ms; transcript had no `event:interrupt` marker |
| A5 | headless | PASS | Tool calls/results paired by `toolUseId`; reload had no missing history items |
>>>>>>> b754e7484 (pod-2919 document final verdicts)
| A6a | terminal | PASS | Attach bytes, typed echo, resize repaint, and second-viewer sharing |
| A7a | headless | PASS | Fresh reaper-pinned setup: daemon `1076504→1079605`; pointer unchanged; codeword recalled |
| A9 | headless `[fix]` | PASS | Fresh stamped PID `1094840` was gone at 15s and 300s; rebound=0; infrastructure=2/2 |
| A10 | both arms | PASS | `opencode-server/server` and explicit `generic-pty/terminal` identity verified |

<<<<<<< HEAD
<<<<<<< HEAD
FAIL/red count: **0** among the current/fix verdicts. There are two PARTIALs (`A1b`,
`A3`). The earlier A9 FAIL is retained as a labelled `[parent]` pre-reaper control,
not counted as a product verdict; the `[fix]` row is the result for the landed reaper.

A9’s fixed-arm reading was pinned to
`fb67ef2278f083bf1bc7036186dea1e183dfcec6`. Server PID `1076330`, daemon PID
`1086980`, and the served bundle all reported that pin (`sourceSha=fb67ef2`); the
headless binding reported `opencode-server/server` with the runtime-driver override
unset. The fresh session was `523a6820-b5d7-455e-b48c-6e366a6a4f4b`, its process was
stamped with daemon UUID `a1ce2d12-849a-4b8c-a64a-d8b23bac46e7`, and its spawned CWD
`/tmp/pod-2919/probes/headless-a9` matched the queried CWD. The independent process
watch covered `/tmp` and worktree cwd locations and found no exact stamped orphan or
PID rebound after the full 300,000 ms.

The parent control at pin `1f531c6cc7efc022db1b90e175c4640906ba97f6` left survivor PID
`847955` in `/tmp/pod-2919/probes/headless-a7a` after five minutes. It is recorded as
`[parent]` in `docs/plans/pod-1761-results.tsv`; the landed reaper run is the adjacent
`[fix]` row. The reaper source was present in the daemon tree before respawn.

## Scorer clause audit (2026-08-27 06:09:49 CEST)

The scorer audit found that a PASS is not proof that every prose clause was checked:

- A1a checks durable user/assistant marker delivery and a non-queued disposition; it does not check a visible `sent` receipt/bubble or an explicit non-silent settle.
- A1b checks a busy control, queued disposition, position in the send response/frames, delivery, durable user text, and a weak reload signal; it does not inspect the visible queued state/position after reload or explicitly require idle delivery.
- A1c checks an alive control and a typed refusal after kill; it does not wait for a later resume-and-send path or independently prove no lost message after the refusal, though the criterion allows refusal OR resume-and-send.
- A2b checks the bound driver, final idle phase, absence of a working/blank bound boot phase, and spawn CWD; it does not require final status to equal `live` beyond excluding `exited`.
- A3 checks the quiet-load gate, the interrupt control, turn stop/settling, and a non-refused control call; it does not enforce the transcript interrupt marker. That missing clause is why this reading is PARTIAL, despite the turn stopping.
- A5 checks tool-call/result pairing by `toolUseId`, missing/orphan IDs, reload item IDs, and the assistant marker; it does not compare exact transcript order/content or duplicate counts.
- A6a checks attach bytes, keystroke echo, bytes after resize, and a loose common line between viewers; it does not verify exact terminal geometry/refit dimensions or exact screen equality.
- A7a checks a changed daemon PID and reconnect, conversation pointer/history, and codeword recall; it does not assert stronger process/session identity invariants.
- A9’s old scorer checked only pre-kill PIDs and infrastructure and ignored stamp eligibility and new-PID rebound. The fixed scorer now requires the current daemon UUID plus a nonempty session stamp, logs foreign UUID backlog as excluded, and checks original orphans, rebound PIDs, and infrastructure after the full watch.
- A10 checks the exact headless driver ID and only the terminal family in the TypeScript scorer; `verify.sh` separately enforces the terminal `PODIUM_RUNTIME_DRIVER=generic-pty` environment precondition.

All populated ledger rows were checked with the eight-field TAB validation. Fresh
A7a and A9 readings are in `docs/evidence/pod-2919/readings/`; older cells retain
their own per-cell pins rather than inheriting the final A9 pin.
=======
Red count: **1** (`A9`). Other incomplete/fullness outcome: one PARTIAL (`A1b`). The
A3 probe scored PASS for a verified stop under the clarified load ceiling, but the
transcript had no `event:'interrupt'` marker; that caveat is retained in the reading.
The process survivor was captured by its environment and `/proc/<pid>/cwd`, then
cleaned by exact PID; final `oc2919` process count was zero and the server/daemon
ports were closed.

The first nine cell readings were pinned to `1f531c6cc7efc022db1b90e175c4640906ba97f6`
with the served bundle reporting `sourceSha=1f531c6`; the A3 re-drive was pinned to
`94dffcda323fb02ad10038e6d7fe7e034f190f9f` with bundle `sourceSha=94dffcd`.
Headless probe CWDs matched the spawned process CWDs. The terminal arm reported its actual spawned CWD as `/`
beside the requested unique probe CWD, so that mismatch is retained in the
individual A6a and A10 readings rather than hidden.
>>>>>>> ca1a74892 (pod-2919 summarize final ten cells)
=======
FAIL/red count: **0** among the current/fix verdicts. There are two PARTIALs (`A1b`,
`A3`). The earlier A9 FAIL is retained as a labelled `[parent]` pre-reaper control,
not counted as a product verdict; the `[fix]` row is the result for the landed reaper.

A9’s fixed-arm reading was pinned to
`fb67ef2278f083bf1bc7036186dea1e183dfcec6`. Server PID `1076330`, daemon PID
`1086980`, and the served bundle all reported that pin (`sourceSha=fb67ef2`); the
headless binding reported `opencode-server/server` with the runtime-driver override
unset. The fresh session was `523a6820-b5d7-455e-b48c-6e366a6a4f4b`, its process was
stamped with daemon UUID `a1ce2d12-849a-4b8c-a64a-d8b23bac46e7`, and its spawned CWD
`/tmp/pod-2919/probes/headless-a9` matched the queried CWD. The independent process
watch covered `/tmp` and worktree cwd locations and found no exact stamped orphan or
PID rebound after the full 300,000 ms.

The parent control at pin `1f531c6cc7efc022db1b90e175c4640906ba97f6` left survivor PID
`847955` in `/tmp/pod-2919/probes/headless-a7a` after five minutes. It is recorded as
`[parent]` in `docs/plans/pod-1761-results.tsv`; the landed reaper run is the adjacent
`[fix]` row. The reaper source was present in the daemon tree before respawn.

## Scorer clause audit (2026-08-27 06:09:49 CEST)

The scorer audit found that a PASS is not proof that every prose clause was checked:

- A1a checks durable user/assistant marker delivery and a non-queued disposition; it does not check a visible `sent` receipt/bubble or an explicit non-silent settle.
- A1b checks a busy control, queued disposition, position in the send response/frames, delivery, durable user text, and a weak reload signal; it does not inspect the visible queued state/position after reload or explicitly require idle delivery.
- A1c checks an alive control and a typed refusal after kill; it does not wait for a later resume-and-send path or independently prove no lost message after the refusal, though the criterion allows refusal OR resume-and-send.
- A2b checks the bound driver, final idle phase, absence of a working/blank bound boot phase, and spawn CWD; it does not require final status to equal `live` beyond excluding `exited`.
- A3 checks the quiet-load gate, the interrupt control, turn stop/settling, and a non-refused control call; it does not enforce the transcript interrupt marker. That missing clause is why this reading is PARTIAL, despite the turn stopping.
- A5 checks tool-call/result pairing by `toolUseId`, missing/orphan IDs, reload item IDs, and the assistant marker; it does not compare exact transcript order/content or duplicate counts.
- A6a checks attach bytes, keystroke echo, bytes after resize, and a loose common line between viewers; it does not verify exact terminal geometry/refit dimensions or exact screen equality.
- A7a checks a changed daemon PID and reconnect, conversation pointer/history, and codeword recall; it does not assert stronger process/session identity invariants.
- A9’s old scorer checked only pre-kill PIDs and infrastructure and ignored stamp eligibility and new-PID rebound. The fixed scorer now requires the current daemon UUID plus a nonempty session stamp, logs foreign UUID backlog as excluded, and checks original orphans, rebound PIDs, and infrastructure after the full watch.
- A10 checks the exact headless driver ID and only the terminal family in the TypeScript scorer; `verify.sh` separately enforces the terminal `PODIUM_RUNTIME_DRIVER=generic-pty` environment precondition.

All populated ledger rows were checked with the eight-field TAB validation. Fresh
A7a and A9 readings are in `docs/evidence/pod-2919/readings/`; older cells retain
their own per-cell pins rather than inheriting the final A9 pin.
>>>>>>> b754e7484 (pod-2919 document final verdicts)
