/**
 * CODEX'S COMPOSER RULES (POD-4477): pure scrape/inject/verify over screen
 * text — one authoritative definition (spec §4).
 *
 * Moved from `driver/families/terminal/prompt-extract.ts` (the extractor) and
 * `driver/families/terminal/composer-sync.ts` (the driver object); the Codex
 * input-ready heuristic moved from
 * `packages/terminal-client/src/session-mount.ts` (`codexInputReady`). The
 * family mechanism is harness-free and takes these as a handed typed subset,
 * while the daemon reads the same functions through the manifest and the
 * browser entry bundles them for the client build (CODE, never served).
 *
 * Browser-safe by construction — a type-only import plus the shared composer
 * vocabulary — so `@podium/harness/browser` may bundle this file.
 */

import type { ComposerScreenLines, HarnessComposer } from '../../manifest.js'
import { CTRL_C, normalizeForVerify, PASTE_END, PASTE_START } from '../shared/composer'

// Codex's composer prompt marker (U+203A, ›). Unlike Claude, Codex draws no box —
// the in-progress prompt is a `› <text>` row near the bottom, with dim hint/status
// rows below it. An empty composer shows a DIM placeholder suggestion (rotating,
// e.g. "Explain this codebase"), indistinguishable from typed text in plain output
// — so the caller must source lines from `screenText({ dropDim: true })`, blanking
// dim cells. That collapses an empty composer to just the marker AND blanks the
// hint/status rows below the input, so a blank row marks the composer's end.
const CODEX_MARKER = '›'

/**
 * Codex's in-progress prompt from the (dim-stripped) rendered screen. Returns the
 * typed text (multiline joined by \n), '' for an empty composer, or null when no
 * composer line is present (callers must NOT overwrite the shared draft on null).
 *
 * Multiline / wrapped input (POD-506): codex renders the extra rows as indent-
 * aligned continuation rows under the marker. We capture the marker row plus the
 * contiguous non-blank rows below it, stopping at the first blank row — which, on
 * dim-stripped input, is the dim hint/status boundary. (Known limitation: a draft
 * with an INTERNAL fully-blank line is truncated at that line — the boundary is
 * indistinguishable from a hint row without codex's box delimiters. The common
 * wrapped/multiline case POD-506 targets has no internal blanks.)
 */
export function extractCodexPromptDraft(lines: ComposerScreenLines): string | null {
  // The composer is the LOWEST marker on screen; any earlier `›` is scrollback.
  let markerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trimStart().startsWith(CODEX_MARKER)) {
      markerIdx = i
      break
    }
  }
  if (markerIdx === -1) return null

  const first = (lines[markerIdx] ?? '').trimStart()
  const firstContent = first.slice(CODEX_MARKER.length).replace(/^ /, '')
  // An EMPTY composer is just the marker row; whatever sits below it is a status /
  // hint line (dim in real codex, so dropDim usually blanks it — but not always, and
  // never when the caller feeds raw lines). A real multiline draft always has a
  // non-empty FIRST line, so only collect continuation rows when the marker row has
  // text. This keeps codex readiness detection ('empty composer') correct.
  if (firstContent.trim() === '') return ''
  const parts: string[] = [firstContent]
  for (let k = markerIdx + 1; k < lines.length; k++) {
    if ((lines[k] ?? '').trim() === '') break
    parts.push((lines[k] ?? '').trimStart())
  }
  const text = parts.join('\n').replace(/\s+$/, '')
  return text.trim() === '' ? '' : text
}

// A codex ">=1000-char paste" collapse — "[Pasted Content N chars]".
const CODEX_PASTE_PLACEHOLDER = /\[Pasted Content \d+ chars?\]/i

export const codexComposer: HarnessComposer = {
  // Codex renders its rotating placeholder + hints DIM, so a scraper must strip
  // them (else it mistakes a suggestion for typed text); claude reads raw. This
  // is the harness-specific screen-read choice, kept behind the rules.
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
  // EMPTY-composer check over DIM-STRIPPED screen lines. The caller sources the
  // lines with dim cells blanked AND keeps the bracketed-paste transport check
  // (DECSET 2004): codex can paint a composer before startup work (notably MCP
  // initialization) redraws it, so an empty composer alone is not proof input
  // is safe — the transport must be up too. Unknown harnesses have no rule, so
  // the client falls back to "no heuristic" rather than a fetched one.
  inputReady: (screen) => extractCodexPromptDraft(screen) === '',
}
