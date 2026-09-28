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
 * Since POD-4775 no cause claims the text was typed: a message that may have
 * been typed and was never proven is `unknown`, not failed, so every failed
 * row here is one the agent never took.
 *
 *  - `never-live`       the agent was not accepting input (a composer that never
 *                       became ready, or a session that never started).
 *  - `teardown`         the session was torn down before it was typed into.
 *  - `delivery-failed`  the agent's machine refused or failed the hand-off.
 *
 * L0 home on purpose: the CLI, web ledger, server steward notice and mobile
 * app all depend on `@podium/model`, while the `QueueDrainAbandonedReason`
 * enum lives in `@podium/protocol/daemon` (daemon-plane, never in the browser
 * graph). These helpers take the reason as a plain string so browser surfaces
 * stay free of that import.
 */

/** The ledger line: "what happened to my message" in one phrase. */
export function deadLetterDeliveryLine(reason: string | null | undefined): string {
  if (reason === 'never-live') return 'not delivered · agent not accepting input'
  if (reason === 'teardown') return 'not delivered · session torn down'
  if (reason === 'delivery-failed') return 'not delivered · delivery failed'
  return 'dead-lettered · target gone'
}

/** The sender-facing gloss for `podium mail status` and the steward notice:
 *  the honest "what happened", with the terminal note so `queued` is never
 *  implied. */
export function deadLetterSenderGloss(reason: string | null | undefined): string {
  if (reason === 'never-live')
    return 'the agent was not accepting input — never typed, not dropped'
  if (reason === 'teardown')
    return 'the session was torn down before it could be typed into — never typed, not dropped'
  if (reason === 'delivery-failed')
    return 'delivery failed before the agent took it — not dropped'
  return 'target was gone — dead-lettered, not dropped'
}
