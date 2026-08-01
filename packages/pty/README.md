# @podium/pty

The PTY kernel (L2). Everything between a child process's pseudo-terminal and the
bytes a client renders — and nothing about *which* agent is being run.

Extracted from `@podium/agent-bridge` in POD-396 (ADR 8 D4). It is deliberately
**harness-agnostic**: it does not know that Claude Code, Codex, Grok, Cursor or
opencode exist. Behavioral branching on harness identity lives in the harness
adapters and only there.

## What it owns

### Backends — `src/backends/`

A swappable `PtyBackend`. `defaultPtyBackend()` picks `Bun.spawn({ terminal })`
when running under Bun **and the running Bun actually has a working terminal
API**, else node-pty. The capability is feature-detected, never inferred from a
version alone: a stale Bun in the daemon once produced `proc.terminal.resize is
undefined` on first attach and every remote terminal rendered black. Under Bun
there is no node-pty fallback (`bun build --compile` cannot embed the native
addon), so a Bun too old fails loud here rather than throwing later.

`PODIUM_PTY_BACKEND=bun-terminal|node-pty` forces the choice.

### Durable hosts — `src/abduco.ts`, `src/abduco-bin.ts`, `src/tmux.ts`

A durable host is what makes a session survive the daemon. abduco is the primary;
tmux is the alternative. Podium ships abduco rather than demanding a system
install: `resolveAbducoBin()` prefers `$PODIUM_ABDUCO`, then `abduco` on PATH,
then a cached build, then compiles the vendored ISC source in `vendor/abduco/`
with the system C compiler. Compiled binaries instead embed a prebuilt abduco and
materialize it into that same cache path on first start (`scripts/build-bun.ts`
and `scripts/embedded-abduco.ts`). abduco is POSIX-only — `abducoSupported()` is
the single place that platform rule lives, and on Windows sessions run on the
ConPTY backend with no durable host \[spec:SP-7f2c].

On Linux each master is additionally wrapped in a transient `systemd-run --user
--scope` so an agent's CPU/IO weight sits below the daemon's; `PODIUM_NO_SCOPE=1`
turns that off for tests and non-systemd hosts.

Durable-host process operations expose one async API: `abducoHasSession`,
`killAbducoSession`, `tmuxHasSession`, `killTmuxServer`, `spawnAbducoAgent`, and
`spawnTmuxAgent`. Callers await them so process creation and listing never block the
interactive loop. The `durable-host-sync-async-twins` deletion-audit item guards this
boundary at zero.

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

`src/*.test.ts` plus `test/` — `test/pty-behavior/spec.ts` is one behavior matrix
run against **both** backends (`.vitest.test.ts` on node-pty, `.bun.test.ts` on
`Bun.Terminal`) so neither can drift. These tests spawn real PTYs: they are
excluded from the unit lane and reap by explicit PID, never `pkill -f`.
