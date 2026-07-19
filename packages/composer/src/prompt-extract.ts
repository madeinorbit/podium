/**
 * Pure extraction of a harness's in-progress composer / prompt-draft text from the
 * rendered terminal screen (one string per visible row, top→bottom).
 *
 * Shared by BOTH the web fallback (browser) and the daemon draft-sync engine, so it
 * stays pure — no DOM, no IO. Moved out of @podium/terminal-client (POD-859) so the
 * daemon can reuse the exact same semantics rather than forking them.
 *
 * See docs/superpowers/specs/2026-07-17-draft-sync-v2-design.md §4.
 */

/** The rendered terminal grid as one string per visible row, top→bottom. */
export type ScreenLines = readonly string[]

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

export function extractClaudePromptDraft(lines: ScreenLines): string | null {
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
export function extractCodexPromptDraft(lines: ScreenLines): string | null {
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
