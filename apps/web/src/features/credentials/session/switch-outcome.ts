/** What a person is told after `sessions.switchCredential` answered (§9). */

import type { SessionSwitchCredentialOutput } from '@podium/commands'

export function switchOutcome(
  result: SessionSwitchCredentialOutput,
  label: string,
): { text: string; openSessionId?: string } {
  if (result.continuedAs === 'handoff') {
    return {
      text: `${label} could not resume this conversation, so it continues in a new session with a summary.`,
      ...(result.handoffSessionId ? { openSessionId: result.handoffSessionId } : {}),
    }
  }
  if (result.waitingForTurnEnd) return { text: `Switches to ${label} when this turn ends.` }
  if (result.continuedAs === 'next-wake') {
    return { text: `Switched to ${label}. It takes effect when the session next starts.` }
  }
  return { text: `Switched to ${label}. The conversation continues.` }
}
