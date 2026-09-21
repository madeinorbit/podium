/**
 * THE CODEX HOOK/SCREEN STATE RULES (POD-4472): the idle-verdict rule for this
 * harness (spec §4: "screen and hook-derived agent state, causal fingerprints").
 *
 * The install layout and payload translation live in `./instrumentation.js`;
 * the state provider in `agent-state/codex.ts` delegates to them. Codex posts
 * no screen-classifiable prompt and no causal fingerprint — its verdict rule
 * (the provider-owned reading of the agent's last message) is the state
 * knowledge this section carries.
 */

/**
 * Best-effort idle verdict from the agent's last message. A trailing question
 * mark reads as "needs answer"; otherwise the turn is done. Codex's rollout has
 * no reliable approval/plan-ready signal (approvals happen in the TUI before any
 * record is written), so we never fabricate one.
 */
export function classifyCodexVerdict(lastAgentMessage: string | undefined): {
  kind: 'done' | 'question'
  summary?: string
} {
  const summary = lastAgentMessage?.trim()
  const kind = summary?.endsWith('?') ? 'question' : 'done'
  return summary ? { kind, summary } : { kind }
}
