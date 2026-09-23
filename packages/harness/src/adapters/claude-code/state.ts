/**
 * THE CLAUDE CODE HOOK/SCREEN STATE RULES (POD-4472): the screen classifier
 * and the causal prompt-hook fingerprint for this harness (spec §4: "screen
 * and hook-derived agent state, causal fingerprints").
 *
 * The install layout and payload translation live in `./instrumentation.js`;
 * the state provider beside it (`./state-provider.js`) delegates to both. Rule
 * ownership stays here: content blocks, tool-result exclusion and injected
 * context stripping remain owned by the fingerprint, and the copy-sensitive
 * screen recognition by the classifier.
 */
import { createHash } from 'node:crypto'
import type { AgentInterview } from '@podium/model'
import {
  type AgentScreenObservation,
  type AgentStateEvent,
  withStateChannel,
} from '../../agent-state/types.js'

export function promptText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value !== 'object' || value === null) return null
  const block = value as Record<string, unknown>
  if (block.type === 'tool_result') return null
  if (block.type === 'text' && typeof block.text === 'string') return block.text.trim() || null
  return null
}

export function isInterruptMarker(text: string): boolean {
  return /^\[Request interrupted by user(?: for tool use)?\]$/i.test(text.trim())
}

export function stripInjectedContext(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`
}

export function fingerprintPromptPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function claudePromptHookFingerprint(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  const prompt = p.prompt ?? p.message ?? p.content
  if (prompt === undefined) return null
  if (typeof prompt === 'string') {
    const raw = prompt.trim()
    if (!raw) return null
    return fingerprintPromptPayload(stripInjectedContext(raw) || raw)
  }
  if (Array.isArray(prompt)) {
    const rawTexts = prompt.map(promptText).filter((value): value is string => value !== null)
    const visibleTexts = rawTexts.map(stripInjectedContext).filter(Boolean)
    const texts = visibleTexts.length > 0 ? visibleTexts : rawTexts
    return texts.length > 0 ? fingerprintPromptPayload(texts.join('\n')) : null
  }
  return fingerprintPromptPayload(prompt)
}
// ---------------------------------------------------------------------------
// Screen rules, moved from agent-state/claude-screen.ts (POD-4472).
// ---------------------------------------------------------------------------

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

/** What a person reads for Claude Code's first-run folder-trust dialog. */
export const CLAUDE_FOLDER_TRUST_SUMMARY = 'Claude Code asks whether you trust this folder'
/** The dialog's question, current copy first (2.1.280), then the older one. */
const FOLDER_TRUST_QUESTIONS = [
  'Is this a project you created or one you trust?',
  'Do you trust the files in this folder?',
] as const
/** Its accept rows. A menu row is a line of its own, which is what keeps a
 *  transcript that merely quotes the labels from matching. */
const FOLDER_TRUST_ACCEPT_ROW = /^(?:❯ )?(?:\d+\. )?Yes, (?:I trust this folder|proceed)$/

/**
 * Claude Code's first-run folder-trust dialog (POD-4632). It blocks the session
 * before any hook fires or any transcript exists, so the screen is the only
 * channel that can see it. It is reported as a wait WITHOUT options on purpose:
 * trust is the user's security decision, and 2.1.280 draws the menu unnumbered,
 * so a digit typed from Chat would not move it. The ask reads "answer in the
 * terminal", which is the truth.
 */
function folderTrustVisible(text: string, visibleLines: readonly string[]): boolean {
  return (
    FOLDER_TRUST_QUESTIONS.some((question) => text.includes(question)) &&
    visibleLines.some((line) => FOLDER_TRUST_ACCEPT_ROW.test(line))
  )
}

/**
 * Claude's own marks that a turn is running, measured on 2.1.280 (POD-4633): the
 * footer's "esc to interrupt" hint, and the spinner row ("✽ Precipitating… (3s ·
 * thinking)"). Each covers the other's gap — a draft in the input box drops the
 * hint while the spinner stays, and streamed text replaces the spinner while the
 * hint stays. A finished turn's row reads "✻ Churned for 3s · done", with no
 * ellipsis, and an interrupted one "⎿ Interrupted · What should Claude do instead?".
 */
const TURN_RUNNING_HINT = 'esc to interrupt'
const TURN_SPINNER_ROW = /^\S [A-Z][a-z]+…(?: |$)/u

function turnRunningVisible(visibleLines: readonly string[]): boolean {
  return visibleLines.some(
    (line) => line.includes(TURN_RUNNING_HINT) || TURN_SPINNER_ROW.test(line),
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
  const autoMode = autoModeVisible(text)
  const folderTrust = !autoMode && folderTrustVisible(text, visibleLines)
  const interactionVisible = autoMode || folderTrust
  const transcriptDisabled = visibleLines.some((line) => line.includes(CLAUDE_TRANSCRIPT_DISABLED))
  const events: AgentStateEvent[] = autoMode
    ? [
        {
          kind: 'needs_user',
          need: 'question',
          summary: CLAUDE_AUTO_MODE_PROMPT,
          interview: AUTO_MODE_INTERVIEW,
        },
      ]
    : folderTrust
      ? [{ kind: 'needs_user', need: 'question', summary: CLAUDE_FOLDER_TRUST_SUMMARY }]
      : transcriptDisabled
        ? [{ kind: 'observation_gap', reason: 'transcript_disabled' }]
        : []

  return {
    events: withStateChannel(events, 'classifier'),
    interactionVisible,
    turnRunning: turnRunningVisible(visibleLines),
    // Claude prints this exact standalone status line after the browser login
    // callback. It is the event that lets the daemon re-probe immediately;
    // the inventory command remains the authority for the resulting state.
    ...(CLAUDE_LOGIN_SUCCESS_SIGNALS.some((signal) => visibleLines.includes(signal))
      ? { auth: 'logged-in' as const }
      : {}),
  }
}
