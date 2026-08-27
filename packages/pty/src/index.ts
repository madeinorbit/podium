/**
 * @podium/pty — the PTY kernel (L2). Owns everything between a child process's
 * pseudo-terminal and the bytes a client renders:
 *
 *  - **backend** — `Bun.spawn({ terminal })`, feature-detected rather than assumed
 *    because a stale Bun in the daemon once rendered every remote terminal black.
 *  - **durable hosts** — abduco (with the vendored ISC source built/embedded on
 *    demand) and tmux, plus the per-master systemd transient scopes that keep an
 *    agent's CPU/IO weight off the daemon's. A durable host is what makes a
 *    session survive the daemon.
 *  - **framing / redraw / OSC scan** — {@link wrapPty} turns raw PTY output into
 *    sequenced raw-byte frames, forces genuine repaints (the shrink-and-restore
 *    nudge, Ctrl-L for idle shells), and lifts the OSC 0/1/2 title the child sets.
 *
 * This package is deliberately **harness-agnostic**: it does not know that Claude
 * Code, Codex, Grok, Cursor or opencode exist. Which CLI is being driven, and how,
 * belongs to the harness adapters — behavioral branching on harness identity lives
 * there and only there (ADR 8 D4; the rewrite's "variance at the edge" axiom).
 * Speaks @podium/protocol geometry types.
 */

export * from './abduco.js'
export * from './abduco-bin.js'
export * from './backends/index.js'
export * from './osc-title.js'
export * from './session.js'
export * from './tmux.js'
