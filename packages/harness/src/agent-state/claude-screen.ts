import type { AgentInterview } from '@podium/model'
import { type AgentScreenObservation, type AgentStateEvent, withStateChannel } from './types.js'

/** Stable copy emitted by Claude Code's environment onboarding modal. */
export const CLAUDE_AUTO_MODE_PROMPT = 'Set up auto mode for your environment?'
/** Stable warning emitted when inherited child-session controls disable history. */
export const CLAUDE_TRANSCRIPT_DISABLED = 'Transcript saving is off'
const CLAUDE_LOGIN_SUCCESS_SIGNALS = ['Login successful', 'Authentication successful'] as const

const AUTO_MODE_OPTIONS = ['Set it up', "Don't show again"] as const

const AUTO_MODE_INTERVIEW: AgentInterview = {
  questions: [
    {
      question: CLAUDE_AUTO_MODE_PROMPT,
      header: 'Auto mode',
      options: [
        {
          label: AUTO_MODE_OPTIONS[0],
          description: 'Let Claude inspect this environment and propose auto-mode guardrails.',
        },
        {
          label: AUTO_MODE_OPTIONS[1],
          description: 'Dismiss this setup prompt without configuring auto mode.',
        },
      ],
    },
  ],
}

function plainScreen(lines: readonly string[]): string {
  // `lines` already come from the daemon's VT buffer, so escape sequences have
  // been interpreted. Joining with spaces also handles a title that wraps at a
  // narrow terminal width without making the classifier depend on columns.
  return lines.join(' ').replace(/\s+/g, ' ').trim()
}

function screenLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

function autoModeVisible(text: string): boolean {
  return (
    text.includes(CLAUDE_AUTO_MODE_PROMPT) &&
    AUTO_MODE_OPTIONS.some((option) => text.includes(option))
  )
}

/**
 * Classify the small amount of Claude UI that has no hook or transcript
 * representation yet. This intentionally recognizes the title plus one of
 * its actions, rather than a generic "permission" word that would turn every
 * Claude dialog into a false positive.
 */
export function classifyClaudeScreen(lines: readonly string[]): AgentScreenObservation {
  const text = plainScreen(lines)
  const visibleLines = screenLines(lines)
  const interactionVisible = autoModeVisible(text)
  const transcriptDisabled = visibleLines.some((line) => line.includes(CLAUDE_TRANSCRIPT_DISABLED))
  const events: AgentStateEvent[] = interactionVisible
    ? [
        {
          kind: 'needs_user',
          need: 'question',
          summary: CLAUDE_AUTO_MODE_PROMPT,
          interview: AUTO_MODE_INTERVIEW,
        },
      ]
    : transcriptDisabled
      ? [{ kind: 'observation_gap', reason: 'transcript_disabled' }]
      : []

  return {
    events: withStateChannel(events, 'classifier'),
    interactionVisible,
    // Claude prints this exact standalone status line after the browser login
    // callback. It is the event that lets the daemon re-probe immediately;
    // the inventory command remains the authority for the resulting state.
    ...(CLAUDE_LOGIN_SUCCESS_SIGNALS.some((signal) => visibleLines.includes(signal))
      ? { auth: 'logged-in' as const }
      : {}),
  }
}
