import {
  createContext,
  type FocusEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

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

/** Focus belongs to the message, including its portalled popup. CSS can hide
 * the old control before the pane measurement commits the replacement. */
export function useMessageActionFocus(narrow: boolean) {
  const wide = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const focus = useRef({ owned: false, action: 'copy', narrow })
  const closeAction = useRef<(() => void) | null>(null)
  const runAfterClose = useCallback((action: () => void) => {
    closeAction.current = action
  }, [])
  const contains = useCallback(
    (target: EventTarget | null) =>
      target instanceof Node &&
      [wide.current, trigger.current, popup.current].some((node) => node?.contains(target)),
    [],
  )
  const wideTarget = useCallback(
    () =>
      wide.current?.querySelector<HTMLButtonElement>(
        `[data-message-action="${focus.current.action}"]`,
      ) ?? wide.current?.querySelector<HTMLButtonElement>('[data-message-action="copy"]'),
    [],
  )
  const onFocusCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    focus.current.owned = true
    const action = event.target.getAttribute('data-message-action')
    if (action === 'copy' || action === 'quote') focus.current.action = action
  }, [])
  const onBlurCapture = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (contains(event.relatedTarget)) return
      const doc = event.currentTarget.ownerDocument
      const elsewhere = event.relatedTarget && event.relatedTarget !== doc.body
      const switching = (wide.current?.getClientRects().length === 0) !== narrow
      // A CSS-hidden control blurs to BODY before React can replace it. An
      // open popup can still be visible while its trigger's layout changes.
      if (!elsewhere && (switching || event.target.getClientRects().length === 0)) return
      focus.current.owned = false
    },
    [contains, narrow],
  )
  const finalFocus = useCallback(() => {
    const doc = wide.current?.ownerDocument
    // Resolve after popup teardown, when the surviving control and any new
    // composer focus are committed. Never restore onto the removed trigger.
    queueMicrotask(() => {
      // A menu can restore its focused item while it closes. Let Quote hand
      // focus to the composer only after that focus management is removed.
      const action = closeAction.current
      closeAction.current = null
      action?.()
      const active = doc?.activeElement
      if (active && active !== doc?.body && !contains(active)) {
        focus.current.owned = false
        return
      }
      const triggerNode = trigger.current
      const target =
        triggerNode?.isConnected && triggerNode.getClientRects().length ? triggerNode : wideTarget()
      if (target?.isConnected && target !== active) target.focus({ preventScroll: true })
    })
    return false
  }, [contains, wideTarget])
  useLayoutEffect(() => {
    if (focus.current.narrow === narrow) return
    focus.current.narrow = narrow
    if (!focus.current.owned) return
    const target = narrow ? trigger.current : wideTarget()
    target?.focus({ preventScroll: true })
  }, [narrow, wideTarget])
  return { wide, trigger, popup, onFocusCapture, onBlurCapture, finalFocus, runAfterClose }
}
