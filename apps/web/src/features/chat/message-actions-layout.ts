import { createContext, type RefObject, useLayoutEffect, useState } from 'react'

export const NarrowMessageActions = createContext(false)

/** One pane measurement, shared by its messages. Wide panes never mount the
 * narrow menu's DOM or menu controllers. Only crossing the breakpoint publishes. */
export function useNarrowMessageActions(scroller: RefObject<HTMLDivElement | null>): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const pane = scroller.current?.parentElement
    if (!pane) return
    const measure = () => setNarrow(pane.clientWidth > 0 && pane.clientWidth < 520)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [scroller])
  return narrow
}
