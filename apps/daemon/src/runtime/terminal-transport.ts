import type { TerminalTransport } from '@podium/harness/driver/host'
import { MESSAGE_WRITE } from '../terminal/foreign-writes.js'
import type { Terminal } from '../terminal/terminal.js'

/**
 * Adapt one daemon Terminal to the harness driver's narrow transport port
 * (POD-4785).
 *
 * pid is deliberately absent: answer ownership uses object identity plus the
 * observer generation/bindingVersion fences, and resource/binding identity is
 * resolved per session by the host. A parked surface reports live=false and
 * drops writes, exactly as Terminal does. Only a turn's own typing carries
 * MESSAGE_WRITE past the foreign-write counter; every other driver write is
 * counted (POD-4888, spec §5.3). The ONE adapter: the bind, the reattach and
 * the handle refresh all hand this, so no copy can drop the write's role.
 * Its own file, so control/session.ts can use it without the runtime/host
 * import cycle, and outside terminal/, which knows no harness.
 */
export function adaptTerminal(terminal: Terminal | undefined): TerminalTransport | undefined {
  if (!terminal) return undefined
  return {
    get live() {
      return terminal.live
    },
    writeBase64: (dataBase64, role) =>
      terminal.writeBase64(dataBase64, role === 'message' ? MESSAGE_WRITE : undefined),
  }
}
