# @podium/process

The PTY kernel (L2). Everything between a child process's pseudo-terminal and the
bytes a client renders — and nothing about *which* agent is being run.

Extracted from `@podium/agent-bridge` in POD-396 (ADR 8 D4). It is deliberately
**harness-agnostic**: it does not know that Claude Code, Codex, Grok, Cursor or
opencode exist. Behavioral branching on harness identity lives in the harness
adapters and only there.

## What it owns

### Backend — `src/backends/`

`defaultPtyBackend()` uses `Bun.spawn({ terminal })`. The capability is
feature-detected, never inferred from a version alone: a stale Bun in the daemon
once produced `proc.terminal.resize is undefined` on first attach and every
remote terminal rendered black. A Bun too old fails loudly at startup.

`PODIUM_PTY_BACKEND=bun-terminal` may pin the only supported backend.

### Durable host — `src/host.ts`, `src/host-bin.ts`, `src/durable-process.ts`, `src/scope.ts`

A durable host is what makes a session survive the daemon. On Linux and macOS it is
podium-host, the Rust crate in `vendor/podium-host-rs/` — the only host Podium spawns
(POD-4986); no C compiler is involved in building or releasing it. `resolveHostBin()`
picks the binary for a new spawn: `$PODIUM_HOST_BIN` (must answer `version` at feature
level `HOST_FEATURES` = 2, else resolution fails), then a release's `podium-host-rs`
beside `podium-cli`, then — in a source checkout — the crate built with cargo on first
use and cached by source hash under `~/.cache/podium/podium-host-rs-src`
(`ensureSourceRustHost()`). With none of these the daemon refuses every spawn
(`HOST_UNAVAILABLE`); there is no fallback. `hostSupported()` is the single place the
platform rule lives: on Windows sessions run on the ConPTY backend with no durable host
\[spec:SP-7f2c].

Production daemon code reaches a host only through `DurableProcess`
(`createDurableProcess()` / `durableProcessFor()`, `@podium/process/durable`); the raw
`spawnHostAgent`, `attachHostAgent`, `hostHasSession`, `killHostSession` and
`listLiveHostLabels` stay exported for tests and the adapter. They are async, so process
creation and listing never block the interactive loop; the
`durable-host-sync-async-twins` deletion-audit item guards this boundary at zero.

Adoption is by socket, not by binary: a session a C host started by an older daemon is
still located and adopted until it exits, because both hosts speak the one protocol in
`src/host.ts`. A session an abduco master holds cannot be re-adopted — abduco is no
longer built or shipped — so `src/legacy-abduco.ts` logs it once by label and leaves
its process alone. `ABDUCO_SOCKET_DIR`, `PODIUM_ABDUCO` and the daemon's
`--backend abduco` are gone.

On Linux each host is additionally wrapped in a transient `systemd-run --user --scope`
(`src/scope.ts`) so a redeploy's cgroup kill cannot reach it and an agent's CPU/IO
weight sits below the daemon's; `PODIUM_NO_SCOPE=1` turns that off for tests and
non-systemd hosts.

### Framing, redraw, OSC scan — `src/session.ts`, `src/osc-title.ts`

`wrapPty` turns raw PTY output into sequenced base64 `AgentFrame`s, and forces
*genuine* repaints: `redraw()` shrinks one row and restores only after the child
emits a frame in response (a timer-based restore races the child's scheduling, the
net size never changes, and no repaint happens), with Ctrl-L for idle shells that
ignore `SIGWINCH` altogether. `createTitleScanner` lifts the OSC 0/1/2 title the
child sets — how agents announce their human-facing name.

Callers must keep PTY-size operations gated on client `viewState`; that gating is
the foundation of visibility behavior and lives with the caller (the daemon), not
here.

## Tests

`src/*.test.ts` plus `test/` — `test/pty-behavior/spec.ts` is the
`Bun.Terminal` behavior matrix. These tests spawn real PTYs: they are
excluded from the unit lane and reap by explicit PID, never `pkill -f`.
