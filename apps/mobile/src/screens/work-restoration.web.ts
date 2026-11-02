import { flushSync } from 'react-dom'

/** Let Router's history listener record this entry before the next route. */
export function saveWorkNavigation(update: () => void, navigate: () => void) {
  flushSync(update)
  queueMicrotask(navigate)
}

export function restoreWorkFocus(id?: string) {
  const target = id ? document.getElementById(id) : null
  target?.focus({ preventScroll: true })
  return target !== null && document.activeElement === target
}
