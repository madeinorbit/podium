import {
  bunTerminalBackend,
  bunVersion,
  hasBunTerminal,
  isUnderBun,
} from './bun-terminal-backend.js'
import { nodePtyBackend } from './node-pty-backend.js'
import type { PtyBackend } from './types.js'

export {
  bunTerminalBackend,
  bunVersion,
  hasBunTerminal,
  isUnderBun,
} from './bun-terminal-backend.js'
export { nodePtyBackend } from './node-pty-backend.js'
export type { PtyBackend, PtyProcess, PtySpawnOptions } from './types.js'

/**
 * Resolve the PTY backend. `PODIUM_PTY_BACKEND` forces a choice; otherwise auto:
 * Bun's terminal PTY when running under Bun with a WORKING terminal API, else node-pty.
 *
 * Under Bun the terminal API is the ONLY PTY: `bun build --compile` can't embed node-pty's
 * native addon, so a compiled daemon has no fallback. A Bun too old for `Bun.spawn({terminal})`
 * therefore must fail LOUD here — silently falling back to a node-pty that will `require`-throw
 * later (or, worse, the historical `proc.terminal.resize is undefined` on first attach → black
 * remote terminals) hides a stale-binary problem. The build itself is guarded too (scripts/
 * build-bun.ts refuses to compile with such a Bun), so this is defense in depth.
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
  if (isUnderBun()) {
    if (!hasBunTerminal())
      throw new Error(
        `Bun ${bunVersion()} lacks a working terminal PTY API (Bun.spawn({terminal}) → proc.terminal); ` +
          `need Bun >= 1.3.5. This daemon binary is stale — rebuild/update it with a newer Bun ` +
          `(a compiled daemon has no node-pty fallback).`,
      )
    return bunTerminalBackend()
  }
  return nodePtyBackend()
}
