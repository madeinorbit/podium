import { useDeviceState } from '@podium/client-core/react'
/**
 * Shared sidebar building blocks (extracted from the retired classic
 * Sidebar.tsx): the resizable aside shell and the persisted per-group fold state.
 */

import type { RoutedUiState } from '@podium/client-core/ui-state'
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useReducedMotion } from '@/lib/use-reduced-motion'
import { cn } from '@/lib/utils'

/** The one aside shell the sidebar renders into. The aside itself never scrolls —
 *  only the work list inside it — so the footer stays pinned. */
export const SIDEBAR_ASIDE_CLASS =
  // No right seam (POD-725): the work list is separated from the flight deck by
  // a tone step, as the design draws it. A border here plus the deck's own edge
  // put two lines in the same 1px of screen.
  // A NAMED CONTAINER (POD-1469). The column is resized by hand, so what its
  // controls have to answer to is the COLUMN's width, never the viewport's — a
  // 200px sidebar on a 3440px display is the case a `sm:` breakpoint gets
  // exactly backwards. `Add repository` reads it to decide whether its words
  // fit; anything else in this column that has to give ground reads the same
  // one.
  'worklist-column flex w-full min-h-0 flex-col bg-sidebar text-sidebar-foreground'

export const SIDEBAR_WIDTH_KEY = 'podium:sidebar:width'
export const SIDEBAR_WIDTH_MIN = 240
export const SIDEBAR_WIDTH_MAX = 360
export const SIDEBAR_WIDTH_DEFAULT = 306

/** Motion for the right dock entering and leaving the layout. */
export const COLLAPSE_MS = 280
export const COLLAPSE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Flight Deck width motion. Section height folds use their own timing. */
export const COLUMN_FOLD_MS = 240
export const COLUMN_FOLD_EASE = 'cubic-bezier(0.4, 0.4, 0.15, 1)'

/**
 * A fixed-width column with a drag-to-resize edge (`handleSide`, default right —
 * a right-docked column resizes from its LEFT edge). The handle lives on a
 * non-scrolling wrapper (the content inside may scroll, so an absolute child of
 * it would only cover the first viewport-height of content). Width persists via
 * the ui-state collection under `storageKey`. This is THE resize mechanism for
 * shell columns — the sidebar, the superagent column, and the right dock all
 * render through it.
 *
 * Pass `collapsed` to make it a DRAWER. The column then keeps its full width
 * internally and animates only the space it TAKES: the root's width runs
 * between 0 and `width`, so the neighbour it shares the row with (the workspace)
 * is pushed aside over the same 280ms instead of jumping. The content is held at
 * its full width inside a clip box pinned to the column's fixed edge — the edge
 * the handle is NOT on — so it slides out from under the chrome beyond that edge
 * rather than reflowing from nothing. Nothing inside the panel relayouts during
 * the animation; only the row does.
 */
export function ResizableColumn({
  storageKey,
  min,
  max,
  defaultWidth,
  handleLabel,
  handleSide = 'right',
  collapsed,
  onCollapsed,
  className,
  children,
}: {
  storageKey: string
  min: number
  max: number
  defaultWidth: number
  handleLabel: string
  handleSide?: 'left' | 'right'
  /** Omit for a plain column; pass a boolean to make it an animated drawer. */
  collapsed?: boolean
  /** Fired once the drawer has finished closing — where the owner drops the
   *  content it had to keep mounted for the exit. Not fired if the drawer is
   *  reopened mid-close. */
  onCollapsed?: () => void
  className?: string
  children: ReactNode
}): JSX.Element {
  const ui = useDeviceState()
  const [width, setWidth] = useState<number>(() => {
    const v = Number(ui.get(storageKey))
    return Number.isFinite(v) && v >= min && v <= max ? v : defaultWidth
  })
  const previousStorageKey = useRef(storageKey)
  useLayoutEffect(() => {
    if (previousStorageKey.current === storageKey) return
    previousStorageKey.current = storageKey
    const stored = Number(ui.get(storageKey))
    setWidth(Number.isFinite(stored) && stored >= min && stored <= max ? stored : defaultWidth)
  }, [storageKey, ui, min, max, defaultWidth])
  const isDrawer = collapsed !== undefined
  const open = !collapsed
  const rootRef = useRef<HTMLDivElement>(null)
  const collapseAnimation = useRef<Animation | null>(null)
  const wasOpen = useRef(open)
  // A drawer surface must use the width the shell actually granted its root,
  // not the persisted wish. The root can be narrower because of a responsive
  // max-width or flex pressure; keeping `width` here makes a right-anchored
  // surface disappear under its own left clip edge.
  const [renderedWidth, setRenderedWidth] = useState(width)
  const reduceMotion = useReducedMotion()
  // Read through a ref so a fresh closure from the owner cannot re-run the
  // animation effect.
  const onCollapsedRef = useRef(onCollapsed)
  onCollapsedRef.current = onCollapsed
  useEffect(() => () => collapseAnimation.current?.cancel(), [])
  // The width React commits IS the end state; WAAPI only holds the other end
  // over it for 280ms. Layout effect so the animation is attached in the same
  // frame the new width lands — a passive effect lets one frame paint open.
  //
  // The guard means only a change in OPENNESS animates, never a resize and
  // never the first render — a drawer restored open on load is simply there.
  useLayoutEffect(() => {
    if (wasOpen.current === open) return
    wasOpen.current = open
    const root = rootRef.current
    // With no motion there is no exit to wait for: the drawer is already shut.
    if (!root || reduceMotion) {
      if (!open) onCollapsedRef.current?.()
      return
    }
    collapseAnimation.current?.cancel()
    // On open, React has already committed the end-state root width. Read it
    // before WAAPI paints the collapsed first frame, then hold that exact width
    // inside the clip for the whole motion. On close the committed root is 0,
    // so retain the last settled measurement.
    const measuredOpenWidth = open ? root.getBoundingClientRect().width : 0
    const animationWidth = measuredOpenWidth > 0 ? measuredOpenWidth : renderedWidth
    if (measuredOpenWidth > 0) setRenderedWidth(measuredOpenWidth)
    const animation = root.animate(
      [{ width: `${open ? 0 : animationWidth}px` }, { width: `${open ? animationWidth : 0}px` }],
      { duration: COLLAPSE_MS, easing: COLLAPSE_EASE, fill: 'both' },
    )
    collapseAnimation.current = animation
    // `cancel()` on reopen does NOT fire this, so an interrupted close never
    // tells the owner to drop the content that is sliding back in.
    animation.onfinish = () => {
      animation.cancel()
      if (collapseAnimation.current === animation) collapseAnimation.current = null
      if (!open) {
        onCollapsedRef.current?.()
        return
      }
      // A viewport can change during the 280ms motion. Settle against the
      // browser's final answer instead of retaining the opening-frame width.
      const settledWidth = root.getBoundingClientRect().width
      if (settledWidth > 0) setRenderedWidth(settledWidth)
    }
  }, [open, renderedWidth, reduceMotion])
  // Outside the open/close motion, follow the root's USED width. This includes
  // viewport caps, flex shrinkage, and pointer resizing. ResizeObserver is the
  // boundary that knows the browser's resolved width; reading the saved pixel
  // value again would recreate the clipping bug on narrow shells.
  // biome-ignore lint/correctness/useExhaustiveDependencies: width requests a synchronous measurement before the ResizeObserver notification.
  useLayoutEffect(() => {
    if (!isDrawer || !open) return
    const root = rootRef.current
    if (!root) return
    const measure = (): void => {
      if (collapseAnimation.current) return
      const next = root.getBoundingClientRect().width
      if (next > 0) setRenderedWidth((current) => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [isDrawer, open, width])
  const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const handle = e.currentTarget
    // The edge OPPOSITE the handle stays put during the drag — measure from it.
    const rect = handle.parentElement?.getBoundingClientRect()
    const anchorLeft = rect?.left ?? 0
    const anchorRight = rect?.right ?? 0
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const raw = handleSide === 'right' ? ev.clientX - anchorLeft : anchorRight - ev.clientX
      setWidth(Math.min(max, Math.max(min, Math.round(raw))))
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      setWidth((w) => {
        ui.set(storageKey, String(w))
        return w
      })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up, { once: true })
    handle.addEventListener('pointercancel', up, { once: true })
  }
  const onHandleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    setWidth((current) => {
      const next =
        e.key === 'Home'
          ? min
          : e.key === 'End'
            ? max
            : Math.min(max, Math.max(min, current + (e.key === 'ArrowLeft' ? -10 : 10)))
      ui.set(storageKey, String(next))
      return next
    })
  }
  return (
    <div
      ref={rootRef}
      className={cn('relative flex min-w-0 flex-[0_1_auto]', className)}
      style={{ width: isDrawer && !open ? 0 : width }}
      data-resizable-column={storageKey}
      data-width={width}
      data-collapsed={isDrawer ? !open : undefined}
    >
      {isDrawer ? (
        // The clip box is the root's own box (inset-0), so it narrows WITH the
        // animation while the panel inside keeps its full width, anchored to the
        // fixed edge. The handle stays outside it: it straddles the boundary by
        // half its width and a clip here would eat that half.
        <div className="absolute inset-0 overflow-hidden">
          <div
            className={cn('absolute inset-y-0 flex', handleSide === 'right' ? 'left-0' : 'right-0')}
            style={{ width: renderedWidth }}
          >
            {children}
          </div>
        </div>
      ) : (
        children
      )}
      {/* A shut drawer has no edge to drag, so the handle goes with it. */}
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: the drag handle is an interactive, keyboard-operable separator
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={handleLabel}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={width}
          tabIndex={0}
          className={cn(
            'absolute inset-y-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60',
            handleSide === 'right' ? '-right-0.5' : '-left-0.5',
          )}
          onPointerDown={onHandlePointerDown}
          onKeyDown={onHandleKeyDown}
        />
      )}
    </div>
  )
}

/** The sidebar's aside shell wired through {@link ResizableColumn}. */
export function ResizableAside({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ResizableColumn
      storageKey={SIDEBAR_WIDTH_KEY}
      min={SIDEBAR_WIDTH_MIN}
      max={SIDEBAR_WIDTH_MAX}
      defaultWidth={SIDEBAR_WIDTH_DEFAULT}
      handleLabel="Resize sidebar"
      className="shrink-0"
    >
      <aside className={SIDEBAR_ASIDE_CLASS}>{children}</aside>
    </ResizableColumn>
  )
}

/**
 * {@link useCollapsed} over a SET of keys, in one subscription (POD-1057).
 *
 * One foldable band per project is a list as long as the machine's repo list, so
 * a hook per group would be a hook in a loop — and the legal shape for that (a
 * component per group) would hide the collapse state from the list that must
 * consult it: the ⌘-hold digits have to skip rows inside a shut band.
 *
 * The snapshot is a bit STRING, not a Set: `useSyncExternalStore` compares by
 * identity, so a fresh Set per read is an infinite render loop. Absent key =
 * expanded.
 */
export function useCollapsedKeys(
  keys: readonly string[],
): [ReadonlySet<string>, (key: string) => void] {
  const ui = useDeviceState() as RoutedUiState | undefined
  const signature = keys.join('\u0000')
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined
  // signature IS the dependency — `keys` is a fresh array on every render.
  const keyList = useMemo(() => (signature === '' ? [] : signature.split('\u0000')), [signature])
  const subscribe = useCallback(
    (onChange: () => void) => (ui ? ui.subscribe(onChange) : () => {}),
    [ui],
  )
  const getSnapshot = useCallback(
    () => keyList.map((key) => (ui?.get(key) === 'true' ? '1' : '0')).join(''),
    [ui, keyList],
  )
  const getServerSnapshot = useCallback(() => '0'.repeat(keyList.length), [keyList])
  const bits = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const collapsed = useMemo(
    () => new Set(keyList.filter((_, index) => bits[index] === '1')),
    [keyList, bits],
  )
  const toggle = useCallback(
    (key: string) => {
      ui?.set(key, ui.get(key) === 'true' ? null : 'true')
    },
    [ui],
  )
  return [collapsed, toggle]
}
