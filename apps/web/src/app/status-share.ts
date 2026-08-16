/**
 * Prefill text for the status-strip X intents.
 *
 * These are personal posts, not product copy: a number first, @podium_ade in
 * the sentence, then a short closer. Hashtags and the 🔥🚢⚡ garnish are
 * how these read as ads; a line break is how they read as a post.
 */

export function shareAgentConcurrency(working: number): string {
  if (working === 0) {
    return '0 agents working in @podium_ade.\n\nrare quiet. I am trying not to ruin it.'
  }
  const noun = working === 1 ? 'agent is' : 'agents are'
  return `${working} ${noun} mid-session in @podium_ade right now.\n\nI have become a very small air-traffic controller.`
}

export function shareTokenBurn(burnPerHour: string): string {
  return `@podium_ade is burning ${burnPerHour}/hr in tokens.\n\nI used to think that number would scare me.`
}

export function shareShipRate(shipped: number): string {
  if (shipped === 0) {
    return '0 ships in 24 hours on @podium_ade.\n\nthe runway is empty. this will not last.'
  }
  const noun = shipped === 1 ? 'issue' : 'issues'
  return `${shipped} ${noun} shipped on @podium_ade in the last 24h.\n\nI am no longer writing the diffs. I am waving them through.`
}
