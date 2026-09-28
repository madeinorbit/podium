/**
 * Shared dead-letter cause wording [POD-4704].
 *
 * A message the server typed but never saw confirmed (injected_at set, still
 * queued) that dies — e.g. cut off mid-turn — is a DELIVERY failure, not a
 * vanished target (POD-4604 run 13). The server stamps `delivery-failed` for
 * such rows; never-pushed rows keep no cause and correctly read as a vanished
 * target. Every surface that renders a dead-letter cause must use these
 * helpers so an unconfirmed send never reads "target gone" while its session
 * is alive. "Target gone" is reserved for a target that is really gone
 * (no cause).
 *
 * L0 home on purpose: the CLI, web ledger, server steward notice and mobile
 * app all depend on `@podium/model`, while the `QueueDrainAbandonedReason`
 * enum lives in `@podium/protocol/daemon` (daemon-plane, never in the browser
 * graph). These helpers take the reason as a plain string so browser surfaces
 * stay free of that import.
 */

/** The ledger line: "what happened to my message" in one phrase. */
export function deadLetterDeliveryLine(reason: string | null | undefined): string {
  if (reason === 'never-live') return 'not delivered · session never became ready'
  if (reason === 'teardown') return 'not delivered · session torn down'
  if (reason === 'delivery-failed') return 'not delivered · delivery failed'
  return 'dead-lettered · target gone'
}

/** The sender-facing gloss for `podium mail status` and the steward notice:
 *  the honest "what happened", with the terminal note so `queued` is never
 *  implied. `delivery-failed` is the typed-but-never-confirmed arm: the
 *  delivery is what failed, not the target. */
export function deadLetterSenderGloss(reason: string | null | undefined): string {
  if (reason === 'never-live')
    return 'the session never became ready within the deadline — never typed, not dropped'
  if (reason === 'teardown')
    return 'the session was torn down before it could be typed into — never typed, not dropped'
  if (reason === 'delivery-failed')
    return 'delivery failed — typed but never confirmed, not dropped'
  return 'target was gone — dead-lettered, not dropped'
}
