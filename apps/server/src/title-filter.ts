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

/** A readable one-line title from a user prompt — the fast fallback while the
 *  agent's own title is still the generic placeholder. First non-empty line,
 *  whitespace-collapsed and capped; undefined for empty input. */
export function titleFromPrompt(text: string, max = 72): string | undefined {
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  const t = (firstLine ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > max ? `${t.slice(0, max)}…` : t
}

export function makeTitleDebouncer(
  emit: (t: string) => void,
  delayMs = 500,
): { push(t: string): void; flush(): void; dispose(): void } {
  let pending: string | undefined
  let lastEmitted: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // Leading-edge: emit the first non-transient title immediately so that a single
  // title push broadcasts synchronously. Subsequent rapid changes arm a trailing
  // timer that emits the final value once the burst quiets (only if it differs
  // from the leading-edge value that was already sent).
  let inBurst = false
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (pending !== undefined && pending !== lastEmitted) {
        lastEmitted = pending
        emit(pending)
      }
      timer = undefined
      inBurst = false
    }, delayMs)
  }
  const doEmit = (t: string) => {
    lastEmitted = t
    emit(t)
  }
  return {
    push(raw) {
      // Compare the stable title so a turning spinner does not become a stream
      // of client updates.
      const t = stripSpinnerFrame(raw)
      if (isTransientTitle(t)) return
      pending = t
      if (!inBurst) {
        // A spinner slower than the quiet window opens a fresh burst on every
        // frame, so the leading edge must still respect the last emitted title.
        inBurst = true
        if (t !== lastEmitted) doEmit(t)
        arm()
      } else {
        // Within a burst: update pending and keep the trailing timer armed.
        arm()
      }
    },
    flush() {
      if (timer) clearTimeout(timer)
      if (pending !== undefined && pending !== lastEmitted) doEmit(pending)
      timer = undefined
      inBurst = false
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = undefined
      inBurst = false
    },
  }
}
