// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
const CONTROL = /[\x00-\x1f\x7f]/

export function isTransientTitle(title: string): boolean {
  const t = title.trim()
  if (t.length === 0) return true
  if (CONTROL.test(title)) return true
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return true
  if (/[⠀-⣿]/.test(t)) return true
  return false
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
    push(t) {
      if (isTransientTitle(t)) return
      pending = t
      if (!inBurst) {
        // Leading edge: emit immediately and start a burst window.
        inBurst = true
        doEmit(t)
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
