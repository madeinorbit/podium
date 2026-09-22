/**
 * CLAUDE CODE'S COMPOSER RULES (POD-4477): pure scrape/inject/verify over
 * screen text — one authoritative definition (spec §4).
 *
 * Moved from `driver/families/terminal/prompt-extract.ts` (the extractor) and
 * `driver/families/terminal/composer-sync.ts` (the driver object): the family
 * mechanism is harness-free and takes these as a handed typed subset, while
 * the daemon reads the same functions through the manifest and the browser
 * entry bundles them for the client build (CODE, never served).
 *
 * Browser-safe by construction — a type-only import plus the shared composer
 * vocabulary — so `@podium/harness/browser` may bundle this file.
 */

import type { ComposerScreenLines, HarnessComposer } from '../../manifest.js'
import { CTRL_U, normalizeForVerify } from '../shared/composer.js'

/**
 * Claude Code's in-progress prompt. The prompt is a rounded box near the bottom:
 *
 *   ╭───────────────────╮
 *   │ > the typed text  │
 *   ╰───────────────────╯
 *
 * Returns the text (continuation lines joined by \n), '' for an empty/placeholder
 * box, or null when no clean box is present (slash/autocomplete overlay, a
 * non-Claude TUI) — callers must NOT overwrite the shared draft on null.
 */
const PLACEHOLDER_PREFIXES = ['Try "', '? for shortcuts', '/ for commands']

export function extractClaudePromptDraft(lines: ComposerScreenLines): string | null {
  let bottom = -1
  let top = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim()
    if (bottom === -1) {
      if (t.startsWith('╰')) bottom = i
      continue
    }
    if (t.startsWith('╭')) {
      top = i
      break
    }
    // A non-border, non-content row inside the box = an overlay/menu replaced it.
    if (!t.startsWith('│') && t !== '') return null
  }
  if (top === -1 || bottom === -1 || bottom - top < 2) return null

  const parts: string[] = []
  for (let k = top + 1; k < bottom; k++) {
    const s = lines[k] ?? ''
    const li = s.indexOf('│')
    const ri = s.lastIndexOf('│')
    if (li === -1 || ri === li) return null
    let content = s.slice(li + 1, ri)
    if (k === top + 1) {
      // The composer's first row always begins with the '>' prompt marker. A
      // rounded box WITHOUT it is a different panel — most notably the startup
      // splash/welcome box (logo, the 🦀 art, tips), which is the only box on
      // screen for a beat before the input renders. Capturing it dumped that art
      // into the chat draft; bail instead so the draft is never clobbered.
      if (!/^\s*>/.test(content)) return null
      content = content.replace(/^\s*>\s?/, '')
    } else content = content.trimStart()
    parts.push(content.replace(/\s+$/, ''))
  }
  const text = parts.join('\n').replace(/\s+$/, '')
  const trimmed = text.trim()
  if (trimmed === '') return ''
  if (PLACEHOLDER_PREFIXES.some((p) => trimmed.startsWith(p))) return ''
  return text
}

// A claude "[Pasted text #N]" collapse — claude may fold a fast multiline paste
// into this placeholder in the composer; it expands to the real text on submit.
const CLAUDE_PASTE_PLACEHOLDER = /\[Pasted text #\d+\]/

export const claudeComposer: HarnessComposer = {
  // Claude reads the raw screen: its placeholder hints live INSIDE the composer
  // box as recognizable text (filtered above), not as dim cells to blank.
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
