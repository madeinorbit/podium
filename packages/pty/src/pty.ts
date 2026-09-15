/**
 * @podium/process/pty — the raw PTY backends (P2a door).
 *
 * What spawns a process on a pseudo-terminal, and nothing else: the
 * `Bun.spawn({ terminal })` backend (feature-detected, never assumed), its
 * capability probes, and the `PtyBackend`/`PtyProcess` ports a caller drives.
 * No durable host, no screen interpretation — those are `./durable` and
 * `./screen`. Files move in P2b/P2c; this subpath only names the door.
 */

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
