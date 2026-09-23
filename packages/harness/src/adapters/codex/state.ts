/**
 * THE CODEX HOOK/SCREEN STATE RULES (POD-4472): the idle-verdict rule for this
 * harness (spec §4: "screen and hook-derived agent state, causal fingerprints").
 *
 * The install layout and payload translation live in `./instrumentation.js`;
 * the state provider beside it (`./state-provider.js`) delegates to them. Codex
 * posts no causal fingerprint. Its state knowledge here is the verdict rule
 * (the provider-owned reading of the agent's last message) and the screen
 * rules for the two prompts no hook or rollout record reports (POD-4650).
 */
import {
  type AgentScreenObservation,
  type AgentStateEvent,
  withStateChannel,
} from '../../agent-state/types.js'

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

/** What a person reads for Codex's directory-trust prompt. */
export const CODEX_TRUST_SUMMARY = 'Codex asks whether you trust this directory'
/** The prompt's question (codex-cli 0.155.0). Matched with whitespace removed,
 *  because Codex wraps it at the terminal width, mid-word. */
const TRUST_QUESTION = 'Do you trust the contents of this directory?'
/** Its accept row. A menu row is a line of its own, which is what keeps a
 *  transcript that merely quotes the label from matching. */
const TRUST_ACCEPT_ROW = /^(?:› )?1\. Yes, continue$/

/** The model-switch menu Codex opens beside a usage-limit error: its question
 *  (the model name varies) and the row that declines it. */
const USAGE_LIMIT_QUESTION = /^Switch to \S+ for lower credit usage\?$/
const USAGE_LIMIT_KEEP_ROW = /^(?:› )?\d+\. Keep current model$/
/** The error printed above the menu when the limit is reached, not just near. */
const USAGE_LIMIT_REACHED = /hit your usage limit\b.*?\btry again at (.+?\d{1,2}:\d{2}(?: ?[AP]M)?)/

/** What a person reads for the usage-limit menu, with the reset time Codex
 *  printed when it printed one. */
export function codexUsageLimitSummary(resetsAt: string | undefined): string {
  return resetsAt
    ? `Codex hit its usage limit (try again at ${resetsAt}) and asks whether to switch models`
    : 'Codex is near its usage limit and asks whether to switch models'
}

function compact(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * Codex's first-run directory-trust prompt (POD-4650). It is drawn before the
 * session exists for any hook to describe, so the screen is the only channel
 * that sees it.
 */
function trustPromptVisible(text: string, visibleLines: readonly string[]): boolean {
  return (
    compact(text).includes(compact(TRUST_QUESTION)) &&
    visibleLines.some((line) => TRUST_ACCEPT_ROW.test(line))
  )
}

/**
 * The model-switch menu Codex opens when an account reaches (or nears) its usage
 * limit (POD-4650). The turn has failed without a Stop hook, and the menu holds
 * the composer until it is answered. The error line stays in the history once
 * the menu closes, so the menu, not the error, is what marks the wait.
 */
function usageLimitMenuVisible(visibleLines: readonly string[]): boolean {
  return (
    visibleLines.some((line) => USAGE_LIMIT_QUESTION.test(line)) &&
    visibleLines.some((line) => USAGE_LIMIT_KEEP_ROW.test(line))
  )
}

/**
 * Classify the Codex prompts that have no hook or rollout representation. Both
 * are reported as a wait WITHOUT options on purpose: trust is the user's
 * security decision and the model switch spends their credits, so neither is
 * answered from Chat. The ask reads "answer in the terminal", which is the truth.
 */
export function classifyCodexScreen(lines: readonly string[]): AgentScreenObservation {
  const text = lines.join(' ').replace(/\s+/g, ' ').trim()
  const visibleLines = lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const trust = trustPromptVisible(text, visibleLines)
  const usageLimit = !trust && usageLimitMenuVisible(visibleLines)
  const events: AgentStateEvent[] = trust
    ? [{ kind: 'needs_user', need: 'question', summary: CODEX_TRUST_SUMMARY }]
    : usageLimit
      ? [
          {
            kind: 'needs_user',
            need: 'question',
            summary: codexUsageLimitSummary(USAGE_LIMIT_REACHED.exec(text)?.[1]),
          },
        ]
      : []
  return { events: withStateChannel(events, 'classifier'), interactionVisible: trust || usageLimit }
}
