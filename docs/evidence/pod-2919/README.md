# POD-2919 opencode acceptance drive

This rig drives the ten cells assigned to the unowned opencode column. It uses
one named instance (`oc2919`), one web bundle, serial cells, and a distinct
probe CWD for every cell because opencode keys its store by CWD. Every reading
records the CWD requested, the CWD observed from the spawned process, the bound
driver, server/daemon/web pins, a positive control, disk and host snapshots.

The headless arm is the normal `opencode-server/server` binding. A10 also
switches the same named instance to `PODIUM_RUNTIME_DRIVER=generic-pty` and
records the deliberate `generic-pty/terminal` demotion.

## Recorded results

| Cell | Arm | Verdict | Evidence |
|---|---|---|---|
| A1a | headless | PASS | Delivered receipt; durable user and assistant marker |
| A1b | headless | PARTIAL | Queued, survived socket reload, and delivered; no position reached the caller |
| A1c | headless | PASS | Dead send returned `dead-lettered: session no longer exists` |
| A2b | headless | PASS | Bound `opencode-server/server`; boot timeline settled idle |
| A3 | headless | UNDRIVEN | Load was 9.75, outside the required approximately-12 window |
| A5 | headless | PASS | Two tool items paired by `toolUseId`; reload had no missing items |
| A6a | terminal | PASS | Attach bytes, typed echo, resize repaint, and second-viewer sharing |
| A7a | headless | PASS | Daemon `824666→848853`; pointer unchanged; codeword recalled |
| A9 | headless | FAIL | PID 847955 remained after 300s from the earlier A7a session in `/tmp` |
| A10 | both arms | PASS | `opencode-server/server` → `generic-pty/terminal` demotion verified |

Red count: **1** (`A9`). Other incomplete/fullness outcomes: one PARTIAL (`A1b`)
and one intentionally UNDRIVEN (`A3`). The process survivor was captured by its
environment and `/proc/<pid>/cwd`, then cleaned by exact PID; final `oc2919`
process count was zero and the server/daemon ports were closed.

The runtime was pinned to `1f531c6cc7efc022db1b90e175c4640906ba97f6` with the
served bundle reporting `sourceSha=1f531c6`. Headless probe CWDs matched the
spawned process CWDs. The terminal arm reported its actual spawned CWD as `/`
beside the requested unique probe CWD, so that mismatch is retained in the
individual A6a and A10 readings rather than hidden.
