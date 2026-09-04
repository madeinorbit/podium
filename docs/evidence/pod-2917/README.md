# POD-2917 current-tip shell acceptance

This directory records the replacement shell-column drive requested after the earlier
`80273fa82` evidence was rejected as stale. The runtime code, server, daemon, and web bundle
were pinned to the full checkout `98ef8d6e08ee53acef2c9dbb1edeafe62e4e88e8`.

Run window: 2026-08-28 13:07:23–13:16:00 CEST. Each cell had a fresh `df -h /` gate:
83G free at A1a, A1c, A2b, A6a, A7a, and A9 start; the A9 independent census still had
82G free. `vmstat` gate samples had swap-in and swap-out at 0/0.

## Named rig and pins

- Instance: `p2917tip0828`.
- Rig bookkeeping root: `/tmp/pod-2917-tip0828`.
- Product-derived state root: `/home/mgw/.local/state/podium/p2917tip0828`.
- Source root: `/home/mgw/src/podium/.worktrees/issue-2917-the-shell-column-nobody-has-driven`.
- Server PID `313446` and daemon PID `313566` at initial cells; A7a restarted the daemon as
  PID `321233`. Every recorded server/daemon spawn pin is the full `98ef8d6e...` SHA.
- Web bundle stamp: source `98ef8d6`, wire digest `c847f4452ebd568b`, bundle
  `bundle+Dbh-P3IM`, built at 2026-08-28 12:35:29 CEST.
- The forbidden product-path overrides were null in every pin: `PODIUM_STATE_DIR`,
  `PODIUM_AGENT_HOME`, `ABDUCO_SOCKET_DIR`, `TMUX_TMPDIR`, and `PODIUM_WEB_DIR`.
- The coordinator ref had docs-only descendants through `182d00fc3` when the branch was
  fast-forwarded after the drive. `git diff --name-only 98ef8d6e0..182d00fc3 | awk '!/^docs\\//'` was
  empty, so the already-built bundle remained valid; no test:heavy or broad test was run.
- The evidence behavior pin is `98ef8d6e0`, while the exact current issue branch is
  `c71b896a9`. Later coordinator descendants include docs-only `d606c06e5` and
  `c71b896a9`; the latter changes only Claude SDK files under `apps/daemon` and
  `packages/agent-runtime`, plus the related model session type, with no shell/terminal
  path touched. The shell readings therefore remain valid under the stale-row rule:
  source, server, daemon, and web bundle were all pinned to `98ef8d6e0`, and the later
  descendant did not alter the measured shell/terminal behavior.

## Cell results

| Cell | Verdict | Positive control | Criterion evidence |
| --- | --- | --- | --- |
| A1a | PASS | Three unique shell markers echoed; the last send replied. | [reading](readings/p2917tip98ef.a1a.json) · [pin](pins/p2917tip98ef-a1a.json) |
| A1c | PASS | Baseline marker `P2874-A1C-CONTROL-MTCULHAQ` echoed and replied. | The dead-session send returned typed `disposition=dead_letter`; [reading](readings/p2917tip98ef.a1c.json) · [pin](pins/p2917tip98ef-a1c.json) |
| A2b | PASS | Unique marker `P2917-A2B-MTCULZ78` echoed in 500ms. | Fresh session status was `phase: idle`; [reading](readings/p2917tip98ef.a2b.json) · [pin](pins/p2917tip98ef-a2b.json) |
| A6a | PASS | Marker `P2874-A6A-MTCUMIQ8` echoed with an attached native viewer. | Keystrokes echoed; geometry refit from 80×24 to 100×30; second viewer replayed the same screen; [reading](readings/p2917tip98ef.a6a.json) · [pin](pins/p2917tip98ef-a6a.json) |
| A7a | PASS | Codeword `P2874-A7A-MTCUN38Q` echoed before and after restart. | The same live shell conversation recalled the codeword; post-restart daemon pin matched; [reading](readings/p2917tip98ef.a7a.json) · [post-restart pin](pins/p2917tip98ef-a7a-post-restart.json) |
| A9 | PASS | Marker `P2917-A9-MTCUNYLK` echoed in 500ms; one target process existed before kill. | Exact process-table census: zero in all ten immediate samples and zero after 300000ms; independent CWD census found no target under the rig or state root; [reading](readings/p2917tip98ef.a9.json) · [pin](pins/p2917tip98ef-a9.json) · [census](p2917tip98ef-a9-census.txt) |

No shell rows were invented for the matrix cells marked n/a (A1b, A2a, A3, A4a, A4b, A5,
A6b, A7b, A8, and A10).

A9's expected server and daemon remained alive during the observation. The independent scan
found only the expected named runtime plus the operator's worktree-side tooling; no shell
session process or extra server had a CWD under the rig root or the product state root.
