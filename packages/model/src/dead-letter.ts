/**
 * Shared dead-letter cause wording [POD-4704, POD-4775].
 *
 * A message the server handed on that then failed is a DELIVERY failure, not a
 * vanished target (POD-4604 run 13). The server stamps a cause on such rows;
 * never-pushed rows keep no cause and correctly read as a vanished target.
 * Every surface that renders a dead-letter cause must use these helpers so a
 * failed delivery never reads "target gone" while its session is alive.
 * "Target gone" is reserved for a target that is really gone (no cause).
 *
 * Since POD-4775 a message that may have been typed and was never proven is
 * `unknown`, not failed. So every failed row here is one the agent never took,
 * or (POD-4887) one its own evidence proves is not in its conversation.
 *
 *  - `never-live`       the agent was not accepting input (a composer that never
 *                       became ready, or a session that never started).
 *  - `teardown`         the session was torn down before it was typed into.
 *  - `delivery-failed`  the agent's machine refused or failed the hand-off.
 *  - `dropped-by-agent`, `not-recorded`, `agent-exited` (POD-4887): typed, and
 *                       proven NOT in the agent's conversation by the agent
 *                       program's own evidence. See
 *                       {@link NOT_IN_CONVERSATION_CAUSES}.
 *
 * L0 home on purpose: the CLI, web ledger, server steward notice and mobile
 * app all depend on `@podium/model`, while the `QueueDrainAbandonedReason`
 * enum lives in `@podium/protocol/daemon` (daemon-plane, never in the browser
 * graph). These helpers take the reason as a plain string so browser surfaces
 * stay free of that import.
 */

/**
 * TYPED, AND PROVEN NOT IN THE CONVERSATION (POD-4887; POD-4819 §6.1). Each is
 * the agent program's own evidence, never a timer or an agent-state reading,
 * so the message is safe to send again:
 *
 *  - `dropped-by-agent` the program recorded that it dropped the message (a
 *                       hook blocked it: Claude's `dropped_by_hook` or "blocked
 *                       by hook" record, Grok's `HookDenied`). N2b.
 *  - `not-recorded`     the program keeps our id, says no turn is open, and our
 *                       id is not in its history (Codex app-server). N3.
 *  - `agent-exited`     the program's process exited and its history, read to
 *                       the end after the exit, holds nothing for it. N4.
 */
export const NOT_IN_CONVERSATION_CAUSES = [
  'dropped-by-agent',
  'not-recorded',
  'agent-exited',
] as const
export type NotInConversationCause = (typeof NOT_IN_CONVERSATION_CAUSES)[number]

export const isNotInConversationCause = (
  value: string | null | undefined,
): value is NotInConversationCause =>
  (NOT_IN_CONVERSATION_CAUSES as readonly (string | null | undefined)[]).includes(value)

/** The ledger line: "what happened to my message" in one phrase. */
export function deadLetterDeliveryLine(reason: string | null | undefined): string {
  if (reason === 'dropped-by-agent') return 'not delivered · the agent dropped it'
  if (reason === 'not-recorded') return 'not delivered · the agent did not record it'
  if (reason === 'agent-exited') return 'not delivered · the agent exited without it'
  if (reason === 'never-live') return 'not delivered · agent not accepting input'
  if (reason === 'teardown') return 'not delivered · session torn down'
  if (reason === 'delivery-failed') return 'not delivered · delivery failed'
  return 'dead-lettered · target gone'
}

/** The sender-facing gloss for `podium mail status` and the steward notice:
 *  the honest "what happened", with the terminal note so `queued` is never
 *  implied. */
export function deadLetterSenderGloss(reason: string | null | undefined): string {
  if (reason === 'dropped-by-agent')
    return 'the agent program dropped it (a hook blocked it) — not in its conversation, safe to resend'
  if (reason === 'not-recorded')
    return 'the agent program ended the turn without recording it — not in its conversation, safe to resend'
  if (reason === 'agent-exited')
    return 'the agent program exited without recording it — not in its conversation, safe to resend'
  if (reason === 'never-live') return 'the agent was not accepting input — never typed, not dropped'
  if (reason === 'teardown')
    return 'the session was torn down before it could be typed into — never typed, not dropped'
  if (reason === 'delivery-failed') return 'delivery failed before the agent took it — not dropped'
  return 'target was gone — dead-lettered, not dropped'
}
