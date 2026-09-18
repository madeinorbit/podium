import { isTransientTitle, stripSpinnerFrame } from '@podium/harness/metadata'
export { isCommandWrapperText, isGenericClaudeTitle, isTransientTitle, stripSpinnerFrame } from '@podium/harness/metadata'

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
