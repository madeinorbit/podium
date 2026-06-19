// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
const CONTROL = /[\x00-\x1f\x7f]/
const SPINNER = /[⠀-⣿⠠⠋⠹]|[|/\\\-]\s*$/ // braille + ascii spinner tails

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
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (pending !== undefined) emit(pending)
      timer = undefined
    }, delayMs)
  }
  return {
    push(t) {
      if (isTransientTitle(t)) return
      pending = t
      arm()
    },
    flush() {
      if (timer) clearTimeout(timer)
      if (pending !== undefined) emit(pending)
      timer = undefined
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
