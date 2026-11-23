/**
 * CODEX'S COMPOSER READINESS RULE (POD-4477): a pure check over screen text.
 *
 * Codex can paint its composer before startup work (notably MCP
 * initialization) redraws it, so the browser client gates synthetic input on
 * an EMPTY composer. This reads the screen only to answer that; it never
 * reads a draft out of the CLI or types one in (POD-7417).
 *
 * Browser-safe by construction — a type-only import — so
 * `@podium/harness/browser` may bundle this file.
 */

import type { ComposerScreenLines, HarnessComposer } from '../../manifest.js'

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
 * composer line is present.
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

export const codexComposer: HarnessComposer = {
  // Codex renders its rotating placeholder + hints DIM, so the screen is read
  // with dim cells blanked (else a suggestion reads as typed text).
  dimStripped: true,
  // EMPTY-composer check over DIM-STRIPPED screen lines. The caller keeps the
  // bracketed-paste transport check (DECSET 2004) too: an empty composer alone
  // is not proof input is safe — the transport must be up as well.
  inputReady: (screen) => extractCodexPromptDraft(screen) === '',
}
