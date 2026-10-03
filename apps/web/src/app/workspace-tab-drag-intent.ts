import {
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type {
  PendingTabDragActivation,
  TabDragKeyboardEventSnapshot,
  TabDragPointerEventSnapshot,
  WorkspaceTabDragRuntimeProps,
} from './workspace-tab-drag'

export type LoadWorkspaceTabDrag = () => Promise<typeof import('./workspace-tab-drag')>

interface TabDomTarget {
  tabId: string
  path: number[]
}

interface FixedStripControlTarget {
  paneId: string
  label: string
}

const tabDomTarget = (target: EventTarget | null, pressable = false): TabDomTarget | null => {
  if (!(target instanceof Element)) return null
  const tab = target.closest<HTMLElement>('[data-tab-drag-id]')
  const tabId = tab?.dataset.tabDragId
  if (!tab || !tabId) return null
  const element = pressable
    ? (target.closest<HTMLElement>('[data-pressable]') ?? tab)
    : target instanceof HTMLElement
      ? target
      : (target.parentElement ?? tab)
  if (!tab.contains(element)) return null

  const path: number[] = []
  let current: Element = element
  while (current !== tab) {
    const parent = current.parentElement
    if (!parent) return null
    const index = [...parent.children].indexOf(current)
    if (index < 0) return null
    path.push(index)
    current = parent
  }
  path.reverse()
  return { tabId, path }
}

const resolveTabDomTarget = (
  workspace: HTMLElement | null,
  target: TabDomTarget,
): HTMLElement | null => {
  const tab = [...(workspace?.querySelectorAll<HTMLElement>('[data-tab-drag-id]') ?? [])].find(
    (candidate) => candidate.dataset.tabDragId === target.tabId,
  )
  if (!tab) return null
  let current: Element = tab
  for (const index of target.path) {
    const child = current.children.item(index)
    if (!child) return null
    current = child
  }
  return current instanceof HTMLElement ? current : null
}

const sameTabDomTarget = (left: TabDomTarget, right: TabDomTarget): boolean =>
  left.tabId === right.tabId &&
  left.path.length === right.path.length &&
  left.path.every((part, index) => part === right.path[index])

const fixedStripControlTarget = (
  target: EventTarget | null,
): { element: HTMLElement; locator: FixedStripControlTarget } | null => {
  if (!(target instanceof Element)) return null
  const element = target.closest<HTMLElement>('[data-pressable]')
  const strip = element?.closest<HTMLElement>('[data-testid="native-tab-strip"]')
  const paneId = strip?.dataset.pane
  const label = element?.getAttribute('aria-label')
  if (!element || !paneId || !label || element.closest('[data-tab-drag-id]')) return null
  return { element, locator: { paneId, label } }
}

const resolveFixedStripControlTarget = (
  workspace: HTMLElement | null,
  target: FixedStripControlTarget,
): HTMLElement | null => {
  const strips = workspace?.querySelectorAll<HTMLElement>('[data-testid="native-tab-strip"]') ?? []
  const strip = [...strips].find((candidate) => candidate.dataset.pane === target.paneId)
  return (
    [...(strip?.querySelectorAll<HTMLElement>('[data-pressable]') ?? [])].find(
      (candidate) => candidate.getAttribute('aria-label') === target.label,
    ) ?? null
  )
}

const pointerSnapshot = (event: PointerEvent): TabDragPointerEventSnapshot => ({
  pointerId: event.pointerId,
  pointerType: event.pointerType,
  isPrimary: event.isPrimary,
  button: event.button,
  buttons: event.buttons,
  clientX: event.clientX,
  clientY: event.clientY,
  ctrlKey: event.ctrlKey,
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  metaKey: event.metaKey,
})

const passedTabDragThreshold = (
  start: TabDragPointerEventSnapshot,
  current: TabDragPointerEventSnapshot,
): boolean => Math.hypot(current.clientX - start.clientX, current.clientY - start.clientY) > 5

const keyboardSnapshot = (event: KeyboardEvent): TabDragKeyboardEventSnapshot => ({
  key: event.key,
  code: event.code,
  ctrlKey: event.ctrlKey,
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  metaKey: event.metaKey,
  repeat: event.repeat,
})

/** Keep mount-stable drag callbacks in an account-independent closure scope.
 * V8 shares captured locals between closures in one render: caching these in
 * Workspace itself also retains that render's account-bound store actions. */
export function useWorkspaceTabDragIntent(loadDragRuntime: LoadWorkspaceTabDrag) {
  const [DragRuntime, setDragRuntime] =
    useState<ComponentType<WorkspaceTabDragRuntimeProps> | null>(null)
  const dragRuntimeRequested = useRef(false)
  const dragFocusToRestore = useRef<TabDomTarget | null>(null)
  // A tab can start the import before focus reaches a fixed strip action. Keep
  // the resolved module unpublished until the next tab intent so wrapping the
  // chrome in DndContext cannot drop its click, focus, or newly opened menu.
  const fixedStripFocusToRestore = useRef<FixedStripControlTarget | null>(null)
  const fixedStripPress = useRef(false)
  const dragRuntimeDeferredUntilIntent = useRef(false)
  const deferredDragRuntime = useRef<ComponentType<WorkspaceTabDragRuntimeProps> | null>(null)
  const clearFixedStripPressListeners = useRef<(() => void) | null>(null)
  const fixedStripPressTimer = useRef<number | null>(null)
  const pendingDragActivation = useRef<
    | {
        kind: 'pointer'
        tabId: string
        pressTarget: HTMLElement
        pressTargetLocator: TabDomTarget
        start: TabDragPointerEventSnapshot
        latestMove: TabDragPointerEventSnapshot | null
        end: TabDragPointerEventSnapshot | null
        dragThresholdCrossed: boolean
      }
    | { kind: 'keyboard'; tabId: string; events: TabDragKeyboardEventSnapshot[] }
    | null
  >(null)
  const clearPendingDragListeners = useRef<(() => void) | null>(null)
  const clearColdDragClickListener = useRef<(() => void) | null>(null)
  const coldDragClickTimer = useRef<number | null>(null)
  const clearColdPressFallback = useRef<(() => void) | null>(null)
  const workspaceRef = useRef<HTMLElement | null>(null)

  const cancelColdPressFallback = useCallback((): void => {
    clearColdPressFallback.current?.()
    clearColdPressFallback.current = null
  }, [])

  const clearColdDragClickSuppression = useCallback((): void => {
    if (coldDragClickTimer.current !== null) {
      window.clearTimeout(coldDragClickTimer.current)
      coldDragClickTimer.current = null
    }
    clearColdDragClickListener.current?.()
    clearColdDragClickListener.current = null
  }, [])

  const deferColdDragClickCleanup = useCallback((): void => {
    if (!clearColdDragClickListener.current || coldDragClickTimer.current !== null) return
    coldDragClickTimer.current = window.setTimeout(clearColdDragClickSuppression, 0)
  }, [clearColdDragClickSuppression])

  const suppressNextColdDragClick = useCallback(
    (tabId: string): void => {
      if (clearColdDragClickListener.current) return
      const ownerDocument = workspaceRef.current?.ownerDocument
      if (!ownerDocument) return
      const suppressClick = (click: MouseEvent): void => {
        const target = click.target
        const clickedTab =
          target instanceof Element
            ? target.closest<HTMLElement>('[data-tab-drag-id]')?.dataset.tabDragId
            : undefined
        if (clickedTab !== tabId) return
        click.preventDefault()
        click.stopPropagation()
        clearColdDragClickSuppression()
      }
      ownerDocument.addEventListener('click', suppressClick, true)
      clearColdDragClickListener.current = () =>
        ownerDocument.removeEventListener('click', suppressClick, true)
    },
    [clearColdDragClickSuppression],
  )

  const clearPendingDragActivation = useCallback((): void => {
    clearPendingDragListeners.current?.()
    clearPendingDragListeners.current = null
    pendingDragActivation.current = null
    clearColdDragClickSuppression()
    cancelColdPressFallback()
  }, [cancelColdPressFallback, clearColdDragClickSuppression])

  const clearFixedStripPress = useCallback((): void => {
    if (fixedStripPressTimer.current !== null) {
      window.clearTimeout(fixedStripPressTimer.current)
      fixedStripPressTimer.current = null
    }
    clearFixedStripPressListeners.current?.()
    clearFixedStripPressListeners.current = null
    fixedStripPress.current = false
    dragRuntimeDeferredUntilIntent.current = false
    deferredDragRuntime.current = null
  }, [])

  const finishFixedStripPress = useCallback((): void => {
    fixedStripPressTimer.current = null
    clearFixedStripPressListeners.current?.()
    clearFixedStripPressListeners.current = null
    fixedStripPress.current = false
  }, [])

  const captureColdFixedStripPress = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): boolean => {
      const fixedTarget = fixedStripControlTarget(event.target)
      if (!fixedTarget) return false
      if (fixedStripPress.current) return true

      clearPendingDragActivation()
      dragFocusToRestore.current = null
      fixedStripPress.current = true
      if (dragRuntimeRequested.current) dragRuntimeDeferredUntilIntent.current = true
      const pointerId = event.pointerId
      const ownerDocument = fixedTarget.element.ownerDocument
      const ownerWindow = ownerDocument.defaultView
      const finishAfterLostBoundary = (): void => {
        if (fixedStripPressTimer.current !== null) return
        clearFixedStripPressListeners.current?.()
        clearFixedStripPressListeners.current = null
        fixedStripPressTimer.current = window.setTimeout(finishFixedStripPress, 0)
      }
      const finishAfterClick = (end: PointerEvent): void => {
        if (end.pointerId === pointerId) finishAfterLostBoundary()
      }
      const finishAfterLostCapture = (end: PointerEvent): void => {
        if (end.pointerId === pointerId) finishAfterLostBoundary()
      }
      const finishWhenHidden = (): void => {
        if (ownerDocument.visibilityState === 'hidden') finishAfterLostBoundary()
      }
      ownerDocument.addEventListener('pointerup', finishAfterClick, true)
      ownerDocument.addEventListener('pointercancel', finishAfterClick, true)
      ownerDocument.addEventListener('visibilitychange', finishWhenHidden, true)
      ownerWindow?.addEventListener('blur', finishAfterLostBoundary, true)
      fixedTarget.element.addEventListener('lostpointercapture', finishAfterLostCapture)
      clearFixedStripPressListeners.current = () => {
        ownerDocument.removeEventListener('pointerup', finishAfterClick, true)
        ownerDocument.removeEventListener('pointercancel', finishAfterClick, true)
        ownerDocument.removeEventListener('visibilitychange', finishWhenHidden, true)
        ownerWindow?.removeEventListener('blur', finishAfterLostBoundary, true)
        fixedTarget.element.removeEventListener('lostpointercapture', finishAfterLostCapture)
      }
      return true
    },
    [clearPendingDragActivation, finishFixedStripPress],
  )

  const captureColdFixedStripKeyPress = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): boolean => {
      if (!dragRuntimeRequested.current) return false
      const fixedTarget = fixedStripControlTarget(event.target)
      if (!fixedTarget) return false
      if (fixedStripPress.current) return true

      clearPendingDragActivation()
      dragFocusToRestore.current = null
      fixedStripPress.current = true
      dragRuntimeDeferredUntilIntent.current = true
      const code = event.code
      const ownerDocument = fixedTarget.element.ownerDocument
      const ownerWindow = ownerDocument.defaultView
      const finishAfterLostBoundary = (): void => {
        if (fixedStripPressTimer.current !== null) return
        clearFixedStripPressListeners.current?.()
        clearFixedStripPressListeners.current = null
        fixedStripPressTimer.current = window.setTimeout(finishFixedStripPress, 0)
      }
      const finishAfterClick = (end: KeyboardEvent): void => {
        if (end.code === code) finishAfterLostBoundary()
      }
      const finishWhenHidden = (): void => {
        if (ownerDocument.visibilityState === 'hidden') finishAfterLostBoundary()
      }
      ownerDocument.addEventListener('keyup', finishAfterClick, true)
      ownerDocument.addEventListener('visibilitychange', finishWhenHidden, true)
      ownerWindow?.addEventListener('blur', finishAfterLostBoundary, true)
      clearFixedStripPressListeners.current = () => {
        ownerDocument.removeEventListener('keyup', finishAfterClick, true)
        ownerDocument.removeEventListener('visibilitychange', finishWhenHidden, true)
        ownerWindow?.removeEventListener('blur', finishAfterLostBoundary, true)
      }
      return true
    },
    [clearPendingDragActivation, finishFixedStripPress],
  )

  const preloadDragRuntime = useCallback(
    (intentTarget: EventTarget | null, restoreFocus = false): void => {
      if (restoreFocus && !DragRuntime) {
        const fixedTarget = fixedStripControlTarget(intentTarget)
        if (fixedTarget) {
          clearPendingDragActivation()
          dragFocusToRestore.current = null
          fixedStripFocusToRestore.current = fixedTarget.locator
          return
        }
      }
      const target = tabDomTarget(intentTarget)
      if (!target) return
      if (restoreFocus && !DragRuntime) dragFocusToRestore.current = target
      if (dragRuntimeDeferredUntilIntent.current && !fixedStripPress.current) {
        dragRuntimeDeferredUntilIntent.current = false
        const deferred = deferredDragRuntime.current
        if (deferred) {
          deferredDragRuntime.current = null
          fixedStripFocusToRestore.current =
            fixedStripControlTarget(workspaceRef.current?.ownerDocument.activeElement ?? null)
              ?.locator ?? null
          setDragRuntime(() => deferred)
          return
        }
      }
      if (dragRuntimeRequested.current) return
      if (fixedStripPress.current) dragRuntimeDeferredUntilIntent.current = true
      dragRuntimeRequested.current = true
      void loadDragRuntime().then(
        (module) => {
          if (fixedStripPress.current || dragRuntimeDeferredUntilIntent.current) {
            deferredDragRuntime.current = module.WorkspaceTabDragRuntime
            return
          }
          fixedStripFocusToRestore.current =
            fixedStripControlTarget(workspaceRef.current?.ownerDocument.activeElement ?? null)
              ?.locator ?? null
          setDragRuntime(() => module.WorkspaceTabDragRuntime)
        },
        () => {
          clearPendingDragActivation()
          clearFixedStripPress()
          dragFocusToRestore.current = null
          fixedStripFocusToRestore.current = null
          dragRuntimeRequested.current = false
        },
      )
    },
    [DragRuntime, clearFixedStripPress, clearPendingDragActivation, loadDragRuntime],
  )

  useEffect(() => clearPendingDragActivation, [clearPendingDragActivation])
  useEffect(() => clearFixedStripPress, [clearFixedStripPress])

  // The plain strip is keyboard-focusable while its runtime is loading. If the
  // provider's arrival replaces that focused node, put focus back on the same
  // tab so Space and the arrow keys work without another trip through the tab
  // order.
  const restoreDragFocus = useCallback((): void => {
    const target = dragFocusToRestore.current
    if (!target) return
    dragFocusToRestore.current = null
    const current = document.activeElement
    const replacement = resolveTabDomTarget(workspaceRef.current, target)
    if (current !== null && current === replacement && current.isConnected) return
    if (current instanceof HTMLElement && current !== document.body && current.isConnected) return
    replacement?.focus()
  }, [])

  const restoreFixedStripFocus = useCallback((): void => {
    const target = fixedStripFocusToRestore.current
    if (!target) return
    fixedStripFocusToRestore.current = null
    const current = document.activeElement
    const replacement = resolveFixedStripControlTarget(workspaceRef.current, target)
    if (current !== null && current === replacement && current.isConnected) return
    if (current instanceof HTMLElement && current !== document.body && current.isConnected) return
    replacement?.focus()
  }, [])

  const replayColdPressIfLost = useCallback(
    (original: HTMLElement, target: TabDomTarget): void => {
      cancelColdPressFallback()
      const ownerDocument = workspaceRef.current?.ownerDocument
      if (!ownerDocument) return
      if (!original.isConnected) {
        resolveTabDomTarget(workspaceRef.current, target)?.click()
        return
      }

      let clickArrived = false
      const onClick = (event: MouseEvent): void => {
        const clicked = tabDomTarget(event.target, true)
        if (!clicked || !sameTabDomTarget(clicked, target)) return
        clickArrived = true
      }
      ownerDocument.addEventListener('click', onClick, true)
      const timer = window.setTimeout(() => {
        ownerDocument.removeEventListener('click', onClick, true)
        clearColdPressFallback.current = null
        if (!clickArrived && !original.isConnected) {
          resolveTabDomTarget(workspaceRef.current, target)?.click()
        }
      }, 0)
      clearColdPressFallback.current = () => {
        window.clearTimeout(timer)
        ownerDocument.removeEventListener('click', onClick, true)
      }
    },
    [cancelColdPressFallback],
  )

  // Restore focus in the commit that replaces the plain tabs. Waiting for the
  // runtime's passive replay effect leaves a painted, observable frame on body
  // when a cold keyboard pickup was cancelled before the import resolved.
  useLayoutEffect(() => {
    if (!DragRuntime) return
    restoreFixedStripFocus()
    restoreDragFocus()
  }, [DragRuntime, restoreDragFocus, restoreFixedStripFocus])

  const captureColdPointerActivation = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (DragRuntime || !event.isPrimary || event.button !== 0) return
      if (captureColdFixedStripPress(event)) return
      const target = event.target
      const tabNode =
        target instanceof Element ? target.closest<HTMLElement>('[data-tab-drag-id]') : null
      const tabId = tabNode?.dataset.tabDragId
      if (!tabId) return
      const pressTargetLocator = tabDomTarget(target, true)
      const pressTarget = pressTargetLocator
        ? resolveTabDomTarget(workspaceRef.current, pressTargetLocator)
        : null
      if (!pressTargetLocator || !pressTarget) return

      clearPendingDragActivation()
      const pending: {
        kind: 'pointer'
        tabId: string
        pressTarget: HTMLElement
        pressTargetLocator: TabDomTarget
        start: TabDragPointerEventSnapshot
        latestMove: TabDragPointerEventSnapshot | null
        end: TabDragPointerEventSnapshot | null
        dragThresholdCrossed: boolean
      } = {
        kind: 'pointer' as const,
        tabId,
        pressTarget,
        pressTargetLocator,
        start: pointerSnapshot(event.nativeEvent),
        latestMove: null,
        end: null,
        dragThresholdCrossed: false,
      }
      pendingDragActivation.current = pending
      const onMove = (move: PointerEvent): void => {
        if (move.pointerId !== pending.start.pointerId) return
        pending.latestMove = pointerSnapshot(move)
        if (
          !pending.dragThresholdCrossed &&
          passedTabDragThreshold(pending.start, pending.latestMove)
        ) {
          pending.dragThresholdCrossed = true
          suppressNextColdDragClick(tabId)
        }
      }
      const stopListening = (): void => {
        clearPendingDragListeners.current?.()
        clearPendingDragListeners.current = null
      }
      const onUp = (end: PointerEvent): void => {
        if (end.pointerId !== pending.start.pointerId) return
        const finish = pointerSnapshot(end)
        const latest = pending.latestMove ?? finish
        if (!pending.dragThresholdCrossed && passedTabDragThreshold(pending.start, latest)) {
          pending.dragThresholdCrossed = true
          suppressNextColdDragClick(tabId)
        }
        if (!pending.dragThresholdCrossed) {
          stopListening()
          pendingDragActivation.current = null
          clearColdDragClickSuppression()
          replayColdPressIfLost(pending.pressTarget, pending.pressTargetLocator)
          return
        }
        pending.latestMove = latest
        pending.end = finish
        stopListening()
        deferColdDragClickCleanup()
      }
      const onCancel = (cancel: PointerEvent): void => {
        if (cancel.pointerId === pending.start.pointerId) clearPendingDragActivation()
      }
      document.addEventListener('pointermove', onMove, true)
      document.addEventListener('pointerup', onUp, true)
      document.addEventListener('pointercancel', onCancel, true)
      clearPendingDragListeners.current = () => {
        document.removeEventListener('pointermove', onMove, true)
        document.removeEventListener('pointerup', onUp, true)
        document.removeEventListener('pointercancel', onCancel, true)
      }
      preloadDragRuntime(target)
    },
    [
      DragRuntime,
      captureColdFixedStripPress,
      clearPendingDragActivation,
      clearColdDragClickSuppression,
      deferColdDragClickCleanup,
      preloadDragRuntime,
      replayColdPressIfLost,
      suppressNextColdDragClick,
    ],
  )

  const captureColdKeyboardActivation = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (DragRuntime || (event.code !== 'Space' && event.code !== 'Enter')) return
      if (captureColdFixedStripKeyPress(event)) return
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.matches('[data-tab-drag-id]')) return
      const tabId = target.dataset.tabDragId
      if (!tabId) return

      event.preventDefault()
      clearPendingDragActivation()
      dragFocusToRestore.current = tabDomTarget(target)
      const pending = {
        kind: 'keyboard' as const,
        tabId,
        events: [keyboardSnapshot(event.nativeEvent)],
      }
      pendingDragActivation.current = pending
      const onKeyDown = (followup: KeyboardEvent): void => {
        if (followup.code === 'Escape') {
          followup.preventDefault()
          clearPendingDragActivation()
          return
        }
        if (
          !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'Tab'].includes(
            followup.code,
          )
        )
          return
        followup.preventDefault()
        pending.events.push(keyboardSnapshot(followup))
      }
      document.addEventListener('keydown', onKeyDown, true)
      clearPendingDragListeners.current = () =>
        document.removeEventListener('keydown', onKeyDown, true)
      preloadDragRuntime(target, true)
    },
    [DragRuntime, captureColdFixedStripKeyPress, clearPendingDragActivation, preloadDragRuntime],
  )

  const preparePendingDragActivation = useCallback((): PendingTabDragActivation | null => {
    restoreDragFocus()
    const pending = pendingDragActivation.current
    if (!pending) return null
    const target = [
      ...(workspaceRef.current?.querySelectorAll<HTMLElement>('[data-tab-drag-id]') ?? []),
    ].find((candidate) => candidate.dataset.tabDragId === pending.tabId)
    if (pending.kind === 'keyboard') {
      clearPendingDragListeners.current?.()
      clearPendingDragListeners.current = null
    }
    pendingDragActivation.current = null
    if (!target) return null
    return pending.kind === 'pointer'
      ? {
          kind: 'pointer',
          target,
          start: pending.start,
          latestMove: pending.latestMove,
          end: pending.end,
        }
      : { kind: 'keyboard', target, events: pending.events }
  }, [restoreDragFocus])

  return {
    DragRuntime,
    workspaceRef,
    preloadDragRuntime,
    captureColdPointerActivation,
    captureColdKeyboardActivation,
    clearColdDragClickSuppression,
    preparePendingDragActivation,
  }
}

