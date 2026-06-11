# abduco PTY host (Option A) — replace tmux as the durability wrapper

## Goal

Keep agent sessions surviving podium/daemon restarts, but delete tmux's
interactive-multiplexer layer (grid, copy-mode, status chrome) so xterm.js is the
only terminal emulator in the stack. abduco is "session detach/reattach, nothing
else": it holds the PTY in a daemonized master and pipes bytes transparently.

## Crux results (verified on this machine, abduco 0.6 built from source)

- Master survives creator-process exit (reparented to user manager, own session) ✓
- Master survives attach-client SIGKILL; reattach works; app keeps running ✓
- SIGTERM to the master kills the app and cleans the session — that's `kill` ✓
- Detach key: client swallows any input chunk whose FIRST byte equals the detach
  key (default `^\` = 0x1c). Remap to 0xff — a byte that can never appear in valid
  UTF-8 input. Verified: with `-e 0xff`, a leading 0x1c arrives intact; with the
  default key it detaches and the whole chunk is lost. The raw 0xff byte cannot be
  produced via node argv (UTF-8 encodes it as 0xC3 0xBF, silently making the detach
  key 0xC3 = first byte of é/à/ö — worse than the default), so the attach command
  goes through `sh -c '... -e "$(printf '\''\377'\'')" ...'`.
- The abduco **client** prints alt-screen chrome on attach (`\e[?1049h\e[H`) when
  its stdin is a tty. Forwarding that to xterm.js would push the whole session into
  the alt buffer and kill scrollback — the exact bug class we're escaping. Strip
  that exact one-time prefix from the stream (split-safe), and dispose with SIGKILL
  so the atexit restore chrome never fires.
- abduco does NOT replay history on attach; it SIGWINCHes the app's process group
  so full-screen TUIs repaint. Browser-reconnect replay remains the relay's job
  (`MAX_REPLAY_BYTES` in apps/server, which survives daemon restarts). Node TUIs
  (Claude Code included) repaint only on a real size CHANGE, so attach nudges a
  shrink/restore resize (reuses wrapPty's ack-based redraw). Verified: real
  Claude Code and bash prompts (readline redraws on WINCH) both repaint after a
  same-geometry reattach. Residual edge: a shell whose foreground process ignores
  SIGWINCH and prints nothing stays blank until its next output — relay replay
  still covers the history for reconnecting browsers.

## Design

`packages/agent-bridge/src/abduco.ts`, mirroring tmux.ts's two-step shape:

- `isAbducoAvailable()` — `abduco -v` probe.
- `abducoCreateArgv` / `abducoAttachArgv` — pure arg builders (unit-testable).
  Create is direct argv (`abduco -n <label> <cmd> <args…>`, no shell quoting);
  cwd/env ride on the create call (the session app inherits them). Force
  `TERM=xterm-256color` + `COLORTERM=truecolor` in the create env — there is no
  tmux `default-terminal` equivalent.
  Attach is `sh -c 'exec abduco -q -e "$(printf '\''\377'\'')" -a "$0"' <label>`
  under node-pty.
- `createAltScreenStripper()` — one-shot split-safe prefix strip of
  `\x1b[?1049h\x1b[H`.
- `spawnAbducoAgent` / `attachAbducoAgent` — create + attach; wrap the pty with the
  stripper, reuse `wrapPty`, override `dispose()` to SIGKILL the client first.
- `parseAbducoList` / `abducoHasSession` / `killAbducoSession` — parse the tab-
  separated `abduco` listing. Status chars (from socket mode bits in the 0.6
  source, NOT the folklore reading): `+` = app terminated (dead), `*` = a client
  is attached (alive), ` ` = detached alive. Kill = SIGTERM the listed pid.

Daemon wiring (`apps/daemon/src/daemon.ts`): generalize `tmux?: boolean` to a
durable-backend choice `abduco | tmux | none` (legacy `tmux: true/false` maps to
`tmux`/`none`; default prefers abduco, falls back to tmux, warns on none).
Reattach becomes backend-agnostic — try abduco's session table, then tmux's — so
pre-upgrade tmux sessions still reattach after the daemon upgrades (no flag day).
Kill calls both reapers (each is a cheap no-op when the label isn't theirs).
The `tmuxLabel` wire field stays as-is (cosmetic debt, noted).

## Tests

`abduco.test.ts`, modeled on tmux.test.ts:
1. Unit (always run): argv builders, list parser (alive/attached/dead/header),
   alt-screen stripper (exact, split, absent, partial-mismatch).
2. Integration (`skipIf !isAbducoAvailable()`): streams frames + OSC title, input
   round-trip, dispose → session survives, reattach → input round-trips again
   (liveness via ECHO, not repaint — abduco doesn't replay), kill → gone.
3. Input-fidelity parity vs direct node-pty: ctrl-C, alt-X, arrow, UTF-8, and
   **0x1c** (the old detach key) — the byte tmux-era tests never had to worry about.

## Deploy note

podium ships abduco: `src/abduco-bin.ts` resolves $PODIUM_ABDUCO → PATH → the
build cache ($PODIUM_STATE_DIR/bin/abduco else ~/.podium/bin/abduco) → compiles
the vendored ISC source (vendor/abduco, ~1s, needs the same C toolchain node-pty
already requires). A system install (`apt install abduco`) is honored first but
no longer required. The daemon warns and falls back to tmux/bare only when no
binary can be obtained at all (no compiler).
