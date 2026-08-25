import {
  bunTerminalBackend,
  bunVersion,
  hasBunTerminal,
  isUnderBun,
  minTerminalBunVersion,
} from './bun-terminal-backend.js'
import type { PtyBackend } from './types.js'

export {
  bunTerminalBackend,
  bunVersion,
  hasBunTerminal,
  isUnderBun,
  minTerminalBunVersion,
  terminalProbeCommand,
} from './bun-terminal-backend.js'
export type { PtyBackend, PtyProcess, PtySpawnOptions } from './types.js'

/**
 * Resolve Podium's Bun PTY backend. A stale Bun must fail here rather than much later
 * when the first remote terminal tries to resize an absent PTY handle.
 */
export function defaultPtyBackend(): PtyBackend {
  const forced = process.env.PODIUM_PTY_BACKEND
  if (forced && forced !== 'bun-terminal')
    throw new Error(`unknown PODIUM_PTY_BACKEND: ${forced}; Podium requires bun-terminal`)
  if (!hasBunTerminal())
    throw new Error(
      `Bun ${bunVersion()} lacks a working terminal PTY API (Bun.spawn({terminal}) → proc.terminal); ` +
        `run Podium under Bun >= ${minTerminalBunVersion()}.`,
    )
  return bunTerminalBackend()
}
