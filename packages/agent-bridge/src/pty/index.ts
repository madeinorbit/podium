import { bunTerminalBackend, hasBunTerminal } from './bun-terminal-backend.js'
import { nodePtyBackend } from './node-pty-backend.js'
import type { PtyBackend } from './types.js'

export type { PtyBackend, PtyProcess, PtySpawnOptions } from './types.js'
export { nodePtyBackend } from './node-pty-backend.js'
export { bunTerminalBackend, hasBunTerminal } from './bun-terminal-backend.js'

/**
 * Resolve the PTY backend. `PODIUM_PTY_BACKEND` forces a choice; otherwise auto:
 * Bun.Terminal when running under Bun with the API present, else node-pty.
 */
export function defaultPtyBackend(): PtyBackend {
  const forced = process.env.PODIUM_PTY_BACKEND
  if (forced === 'bun-terminal') {
    if (!hasBunTerminal())
      throw new Error(
        'PODIUM_PTY_BACKEND=bun-terminal but Bun.Terminal is unavailable (run under Bun >=1.3.5)',
      )
    return bunTerminalBackend()
  }
  if (forced === 'node-pty') return nodePtyBackend()
  if (forced) throw new Error(`unknown PODIUM_PTY_BACKEND: ${forced}`)
  return hasBunTerminal() ? bunTerminalBackend() : nodePtyBackend()
}
