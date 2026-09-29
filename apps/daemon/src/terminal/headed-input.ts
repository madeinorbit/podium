import type { SessionId } from '@podium/model'
import type { SessionRegistry } from '../session/registry.js'

/**
 * Keystrokes into a headed session's terminal, as a person at it would type —
 * the daemon's own control writes that are not a turn: Draft Sync's composer
 * edits and the Ctrl-U that clears a prompt Claude put back after an
 * interrupt. Through the Terminal's write call, so each one is a counted
 * foreign write (POD-4888). A client TUI takes human keystrokes only.
 */
export function writeHeadedInput(
  sessions: SessionRegistry,
  sessionId: SessionId,
  bytes: string,
): void {
  const terminal = sessions.get(sessionId)?.terminal
  if (terminal?.kind === 'headed')
    terminal.writeBase64(Buffer.from(bytes, 'utf8').toString('base64'))
}
