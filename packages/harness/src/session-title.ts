// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
const CONTROL = /[\x00-\x1f\x7f]/

/**
 * Known leading frames emitted with a real terminal title. A closed set matters
 * here because titles may legitimately begin with symbols such as `●` or `○`.
 * Braille stays out of the set because `isTransientTitle` rejects a title that
 * contains it, allowing the prompt-derived fallback to win.
 */
const SPINNER_FRAMES = '◐◑◒◓▁▂▃▄▅▆▇█✲✳✴✶✷✸✹✺'
const LEADING_SPINNER = new RegExp(`^[${SPINNER_FRAMES}]+[\\s\\u00a0]+(?=\\S)`, 'u')

/** The title without its spinner frame; unchanged when there is not one. */
export function stripSpinnerFrame(title: string): string {
  return title.replace(LEADING_SPINNER, '')
}

export function isTransientTitle(title: string): boolean {
  const t = title.trim()
  if (t.length === 0) return true
  if (CONTROL.test(title)) return true
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return true
  if (/[⠀-⣿]/.test(t)) return true
  return false
}

/** The generic placeholder Claude Code shows before it generates a real title.
 *  We treat it as low-priority: a first-prompt title beats it, and it must never
 *  overwrite a real title the agent later sets. */
export function isGenericClaudeTitle(title: string): boolean {
  return title.trim() === 'Claude Code'
}

/** Claude Code records a first turn that was a slash command (`/model`, `/effort`)
 *  as a pseudo-XML wrapper in the transcript — `<command-name>/model</command-name>`,
 *  `<command-message>…`, `<local-command-stdout>…` — rather than as prose the user
 *  typed. Titling a session from that wrapper produces the literal
 *  "<command-name>/model</command-name>" as the session name, and because the
 *  first-prompt fallback also LOCKS the title, it sticks for the life of the
 *  session. Such a turn is not a prompt and can never be a title: skip it and wait
 *  for the first real one. Same rule the discovery providers already apply when
 *  parsing transcripts from disk (discovery/providers/claude-code.ts). [spec:SP-eb60] */
export function isCommandWrapperText(text: string): boolean {
  return text.trim().startsWith('<')
}
