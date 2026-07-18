/**
 * ComposerDriver — the ONLY place harness-specific composer behavior lives (design
 * §4). The engine, lease arbitration, and injection state machine are all
 * harness-agnostic; they drive a session's composer purely through this interface.
 *
 * Pure: every method is a function of screen lines / text → screen read or byte
 * sequence. No IO, so it is shared by the web fallback and the daemon engine and is
 * exhaustively fixture-testable.
 *
 * See docs/superpowers/specs/2026-07-17-draft-sync-v2-design.md §4, §5.
 */

import type { AgentKind } from '@podium/protocol'
import {
  extractClaudePromptDraft,
  extractCodexPromptDraft,
  type ScreenLines,
} from './prompt-extract'

/** Ctrl-U (kill-line). Claude clears its composer with one per line. */
export const CTRL_U = '\x15'
/** Ctrl-C. Codex clears a NON-EMPTY composer with it (stashes to history); on an
 *  empty composer it arms quit — never send it blind. */
export const CTRL_C = '\x03'
/** Bracketed-paste start (ESC[200~) — makes the burst a single literal paste. */
export const PASTE_START = '\x1b[200~'
/** Bracketed-paste end (ESC[201~). */
export const PASTE_END = '\x1b[201~'

export interface ComposerDriver {
  /** Whether the screen must be read with dim cells blanked before extraction.
   *  Codex renders its rotating placeholder + hints DIM, so a scraper must strip
   *  them (else it mistakes a suggestion for typed text); claude reads raw. This
   *  is the harness-specific screen-read choice, kept behind the driver. */
  readonly dimStripped: boolean
  /** The current composer text, or null = no clean composer on screen
   *  (overlay/splash/menu/streaming) — the engine must NEVER clobber on null. */
  extract(screen: ScreenLines): string | null
  /** Composer present and safe to write (no overlay; agent not mid-stream). */
  injectable(screen: ScreenLines): boolean
  /** Bytes clearing the WHOLE composer for its current text; null = cannot/should
   *  not clear now (e.g. codex empty composer). */
  clearSequence(currentText: string): string | null
  /** Bytes entering `text` into the composer WITHOUT submitting it. */
  typeSequence(text: string): string
  /** Post-injection check. 'placeholder' = the harness collapsed the paste to its
   *  own marker (acceptable — it expands on submit). */
  verify(screen: ScreenLines, expected: string): 'match' | 'placeholder' | 'mismatch'
}

// A claude "[Pasted text #N]" collapse — claude may fold a fast multiline paste
// into this placeholder in the composer; it expands to the real text on submit.
const CLAUDE_PASTE_PLACEHOLDER = /\[Pasted text #\d+\]/
// A codex ">=1000-char paste" collapse — "[Pasted Content N chars]".
const CODEX_PASTE_PLACEHOLDER = /\[Pasted Content \d+ chars?\]/i

// Verify is a coarse "did the text land" check, not an exact-fidelity one. A line
// wider than the PTY wraps, so the scrape comes back with an extra newline where the
// injected text had none (or a space) — exact equality would false-mismatch, trigger
// a re-inject, and self-demote (reviewer blocker 3). Collapsing all whitespace makes
// verify wrap-insensitive (mid-word AND at-space wraps) while still catching a truly
// different composer.
function normalizeForVerify(s: string): string {
  return s.replace(/\s+/g, '')
}

export const claudeComposerDriver: ComposerDriver = {
  dimStripped: false,
  extract: extractClaudePromptDraft,
  injectable: (screen) => extractClaudePromptDraft(screen) !== null,
  // Ctrl-U kills to line-start; one per composer line clears a multiline draft.
  clearSequence: (currentText) => CTRL_U.repeat(Math.max(1, currentText.split('\n').length)),
  // Claude newlines are backslash+Enter continuations; the text is otherwise literal.
  typeSequence: (text) => text.split('\n').join('\\\r'),
  verify: (screen, expected) => {
    const got = extractClaudePromptDraft(screen)
    if (got === null) return 'mismatch'
    if (normalizeForVerify(got) === normalizeForVerify(expected)) return 'match'
    if (CLAUDE_PASTE_PLACEHOLDER.test(got)) return 'placeholder'
    return 'mismatch'
  },
}

export const codexComposerDriver: ComposerDriver = {
  dimStripped: true,
  extract: extractCodexPromptDraft,
  injectable: (screen) => extractCodexPromptDraft(screen) !== null,
  // Ctrl-C wipes a NON-EMPTY codex composer (stashed to history). On an empty
  // composer it arms quit, so refuse to clear — null means "no clear needed/safe".
  clearSequence: (currentText) => (currentText ? CTRL_C : null),
  // One bracketed-paste burst: newlines stay literal inside it, and there is no
  // trailing CR — the engine never submits as a side effect of typing.
  typeSequence: (text) => `${PASTE_START}${text}${PASTE_END}`,
  verify: (screen, expected) => {
    const got = extractCodexPromptDraft(screen)
    if (got === null) return 'mismatch'
    if (normalizeForVerify(got) === normalizeForVerify(expected)) return 'match'
    if (CODEX_PASTE_PLACEHOLDER.test(got)) return 'placeholder'
    return 'mismatch'
  },
}

/** The composer driver for a harness, or null when it has none (matches the
 *  `composerScrape` capability: only claude-code and codex today). */
export function composerDriverFor(kind: AgentKind): ComposerDriver | null {
  if (kind === 'claude-code') return claudeComposerDriver
  if (kind === 'codex') return codexComposerDriver
  return null
}
