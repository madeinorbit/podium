/**
 * Prefill text for the status-strip X intents, plus the dollar format they and
 * the strip readout share.
 *
 * These are personal posts, not product copy: a number first, @podium_ade in
 * the sentence, then a short closer. Hashtags and the 🔥🚢⚡ garnish are
 * how these read as ads; a line break is how they read as a post.
 *
 * The burn post says *I* am burning, with @podium_ade as the instrument — the
 * bill is the operator's, and a product-subject sentence ("@podium_ade is
 * burning") reads like the tool did it on its own.
 */

/** Below this hourly burn the number is not a flex, so the closer changes. */
const LOW_BURN_USD_PER_HOUR = 5

/** Dollars at a precision that survives both $0.004 and $120. */
export function money(value: number): string {
  const digits = value >= 10 ? 1 : value >= 0.1 ? 2 : value > 0 ? 3 : 0
  return `$${value.toFixed(digits)}`
}

export function shareAgentConcurrency(working: number): string {
  if (working === 0) {
    return '0 agents working in @podium_ade.\n\nrare quiet. I am trying not to ruin it.'
  }
  const noun = working === 1 ? 'agent is' : 'agents are'
  return `${working} ${noun} mid-session in @podium_ade right now.\n\nI have become a very small air-traffic controller.`
}

export function shareTokenBurn(burnPerHour: number): string {
  const amount = money(burnPerHour)
  if (burnPerHour < LOW_BURN_USD_PER_HOUR) {
    return `I am running @podium_ade on ${amount}/hr in tokens.\n\na rounding error with commit access.`
  }
  return `I am burning ${amount}/hr in tokens with @podium_ade.\n\nI used to think that number would scare me.`
}

export function shareShipRate(shipped: number): string {
  if (shipped === 0) {
    return '0 ships in 24 hours on @podium_ade.\n\nthe runway is empty. this will not last.'
  }
  const noun = shipped === 1 ? 'issue' : 'issues'
  return `${shipped} ${noun} shipped on @podium_ade in the last 24h.\n\nI am no longer writing the diffs. I am waving them through.`
}
