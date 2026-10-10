/** A view owns refresh demand. Hidden/closed views stop the timer and fence
 * replies; a directory with no push contract refreshes when shown again. */
export function followVisibleRequest(load: () => void, visibility: {
  visible(): boolean
  subscribe(changed: () => void): () => void
}, everyMs = 15_000): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const reconcile = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (closed || !visibility.visible()) return
    load()
    timer = setTimeout(reconcile, everyMs)
  }
  const stop = visibility.subscribe(reconcile)
  reconcile()
  return () => { closed = true; if (timer !== undefined) clearTimeout(timer); stop() }
}
