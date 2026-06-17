/**
 * Best-effort extraction of Claude Code's in-progress prompt text from the
 * rendered terminal screen (one string per visible row, top→bottom). The prompt
 * is a rounded box near the bottom:
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

export function extractClaudePromptDraft(lines: string[]): string | null {
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
// the in-progress prompt is a single line `› <text>` near the bottom. An empty
// composer shows a DIM placeholder suggestion (rotating, e.g. "Explain this
// codebase"), which is indistinguishable from typed text in plain output — so the
// caller must source lines from `screenText({ dropDim: true })`, blanking dim
// cells. That collapses an empty composer to just the marker; only typed text
// survives.
const CODEX_MARKER = '›'

/**
 * Codex's in-progress prompt from the (dim-stripped) rendered screen. Returns the
 * typed text, '' for an empty composer, or null when no composer line is present
 * (the caller must NOT overwrite the shared draft on null).
 */
export function extractCodexPromptDraft(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trimStart()
    if (!t.startsWith(CODEX_MARKER)) continue
    const after = t.slice(CODEX_MARKER.length).replace(/^ /, '')
    return after.trim() === '' ? '' : after.replace(/\s+$/, '')
  }
  return null
}
