# POD-2873 runtime evidence

Captured on 2026-08-26 from the fixed source at `3d7fa89bc7f773a95bdfb753f02e2bf8efa738ea`.
The control uses the immediate pre-fix source at `9ce04fc891aecdab6693d6ca308b622481cf4a1e`.

## Result

| arm | instance and agent home | after daemon restart | direct socket reading |
| --- | --- | --- | --- |
| `control-custom` | default; `PODIUM_AGENT_HOME` distinct from natural `HOME` | persisted row `exited`, `spawn_failure=null` | live master remained under the agent home: the pre-fix leak |
| `fixed-custom-default` | default; `PODIUM_AGENT_HOME` distinct from natural `HOME` | API and DB rows `live`, `spawn_failure=null` | live master found under the agent home |
| `fixed-named` | `pod2873n`; product-derived agent home | API and DB rows `live`, `spawn_failure=null` | live master found under the product-derived named socket root |
| `fixed-default-safe` | default; agent home equals natural `HOME` | API and DB rows `live`, `spawn_failure=null` | live master found under `$HOME/.abduco` |

Every arm created one shell terminal, captured the complete API and SQLite rows,
restarted only the daemon, and made one direct scan of each candidate socket
directory before and after the restart. The control's `exited` row plus its still-
live socket is the session-not-found surface: the session appears gone while its
master remains running and unreclaimed.

## What the drive proves

The spawn path creates the master with the child environment's `ctx.homeDir`.
Before the fix, the reattach path resolved both the socket path and its probe from
the daemon environment instead. On the default instance with a custom
`PODIUM_AGENT_HOME`, those roots differ. The fixed arms pass `ctx.homeDir` over the
daemon environment at both reattach call sites.

The named arm has no `ABDUCO_SOCKET_DIR` supplied by the rig; the daemon applies
the product's named-instance pin at bootstrap. The default-safe arm also has no
agent-home override, so both sides naturally resolve the same home. The custom
default arm is the exposed configuration. No arm sets `PODIUM_STATE_DIR`,
`ABDUCO_SOCKET_DIR`, `TMUX_TMPDIR`, or an artificial `HOME`.

## Reproduce

The wrapper uses an unprivileged `bwrap` mount namespace per arm. It keeps the
natural `HOME=/home/mgw` environment, mounts a fresh directory over that home so
the real default instance is untouched, and supplies writable tmpfs mounts for
`/tmp` and the natural `/run/user/<uid>` runtime path. `PODIUM_NO_SCOPE=1` keeps
the terminal master inside that namespace; it changes containment only, not the
HOME/socket resolution under test. The drive uses direct tRPC calls, so the web
bundle is deliberately not loaded.

```sh
git worktree add --detach /tmp/pod-2873-control 9ce04fc891aecdab6693d6ca308b622481cf4a1e
PODIUM_TEST_WORKERS=1 \
POD2873_CONTROL_REPO=/tmp/pod-2873-control \
POD2873_EVIDENCE_DIR=docs/evidence/pod-2873/readings \
bash docs/evidence/pod-2873/drive.sh
```

The wrapper records the source SHA before each server and daemon boot. The four
readings in this directory are the output from the completed run; the component
logs are intentionally kept in each temporary arm root rather than copied into
the repository.

## Validation record

`PODIUM_TEST_WORKERS=1 bun run typecheck` was green (25/25 tasks, 23 cached).
`PODIUM_TEST_WORKERS=1 bun run test:unit -- --filter @podium/daemon` ran the
daemon lane and had 1,250 passed tests plus 5 skipped, with two unrelated
baseline failures: the retired state-root socket pin assertion in
`instance-bootstrap.test.ts`, and the inherited HOME/PATH shape assertion in
`headless-drivers.test.ts`. No full sweep was run. This follow-up changes only
the runtime evidence rig and its recorded readings, so the earlier code gates
remain the applicable product validation.
