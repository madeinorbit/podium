/**
 * @podium/process — the process kernel (L2). Owns everything between a child
 * process and the bytes a client renders:
 *
 *  - **backends** (`./pty`) — `Bun.spawn({ terminal })`, feature-detected
 *    rather than assumed because a stale Bun in the daemon once rendered every
 *    remote terminal black.
 *  - **durable hosts** (`./durable`) — abduco (with the vendored ISC source
 *    built/embedded on demand), plus the per-master systemd transient scopes
 *    that keep an agent's CPU/IO weight off the daemon's. A durable host is
 *    what makes a session survive the daemon. Import `./durable` to reach it:
 *    the root deliberately does NOT re-export it, so building a durable host
 *    is always a visible, deliberate import (P2a closes the blanket hole that
 *    let a module do it unnoticed).
 *  - **framing / redraw / OSC scan** (`./screen`) — {@link wrapPty} turns raw
 *    PTY output into sequenced raw-byte frames, forces genuine repaints (the
 *    shrink-and-restore nudge, Ctrl-L for idle shells), and lifts the OSC 0/1/2
 *    title the child sets. Cgroup resource helpers and POSIX shell quoting
 *    live here too.
 *
 * This package is deliberately **harness-agnostic**: it does not know that
 * Claude Code, Codex, Grok, Cursor or opencode exist. Which CLI is being
 * driven, and how, belongs to the harness adapters — behavioral branching on
 * harness identity lives there and only there (ADR 8 D4; the rewrite's
 * "variance at the edge" axiom). Speaks @podium/protocol geometry types.
 *
 * Doors (P2a): no `export *` remains in this package. Each subpath exports a
 * named list; the root re-exports `./pty` + `./screen` only. The
 * `@podium/runtime/scope` re-export is gone: a process package is not the door
 * to runtime scopes — import `@podium/runtime/scope` directly.
 */

// ./pty — raw backends.
export {
  bunTerminalBackend,
  bunVersion,
  hasBunTerminal,
  isUnderBun,
  minTerminalBunVersion,
  terminalProbeCommand,
  defaultPtyBackend,
} from './backends/index.js'
export type { PtyBackend, PtyProcess, PtySpawnOptions } from './backends/index.js'

// ./screen — session wrapper, title scan, cgroup helpers, shell quoting.
export {
  type SpawnOptions,
  type AgentFrame,
  type AgentSession,
  withHardRepaint,
  spawnAgent,
  wrapPty,
} from './session.js'
export { type TitleScanner, createTitleScanner } from './osc-title.js'
export {
  cgroupRoot,
  type CgroupSample,
  parseCgroupScalar,
  parseCgroupKeyed,
  parseProcCgroup,
  cgroupPathForPid,
  readCgroupSample,
  controlGroupQueryArgv,
  cgroupPathForControlGroup,
  sliceChainPath,
  userManagerCgroupBase,
  sessionScopeCgroupPath,
  parseCgroupPressure,
  readCgroupPressure,
} from './cgroup.js'
export { shellQuote } from './shell-quote.js'
export { createAltScreenStripper } from './alt-screen-stripper.js'
