import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PULL_REFRESH_THRESHOLD,
  pullWillRefresh,
  resistedPullDistance,
} from '../lib/pull-to-refresh'
import { color, font, mono, radius } from '../theme/theme'

const START_SLOP = 7
const CONFIRMED_MS = 700
const PULLING_TRANSITION = 'opacity 80ms linear'
const SETTLING_TRANSITION = 'transform 180ms ease, opacity 160ms ease'

interface ActivePointer {
  id: number
  startY: number
  scrollElement: HTMLElement | null
}

function verticalScroller(target: EventTarget | null, boundary: HTMLElement): HTMLElement | null {
  let element = target instanceof HTMLElement ? target : null
  while (element && element !== boundary) {
    const overflowY = getComputedStyle(element).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return element
    element = element.parentElement
  }
  return null
}

function atTop(element: HTMLElement | null): boolean {
  return !element || element.scrollTop <= 1
}

export function PullToRefreshBoundary({
  children,
  connected,
  refreshing,
  onRefresh,
}: {
  children: ReactNode
  connected: boolean
  refreshing: boolean
  onRefresh: () => void
}) {
  const boundaryRef = useRef<HTMLDivElement>(null)
  const pointer = useRef<ActivePointer | null>(null)
  const touch = useRef<ActivePointer | null>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  const distanceRef = useRef(0)
  const pendingDistanceRef = useRef(0)
  const animationFrameRef = useRef<number | null>(null)
  const armedRef = useRef(false)
  const refreshTriggered = useRef(false)
  const wasRefreshing = useRef(false)
  const confirmationTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [armed, setArmed] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const paintPullDistance = useCallback((distance: number) => {
    const indicator = indicatorRef.current
    if (!indicator) return
    indicator.style.transition = distance > 0 ? PULLING_TRANSITION : SETTLING_TRANSITION
    indicator.style.opacity = distance > 0 ? '1' : '0'
    indicator.style.transform = `translate(-50%, ${distance - 42}px)`
  }, [])

  const cancelScheduledFrame = useCallback(() => {
    if (animationFrameRef.current === null) return
    cancelAnimationFrame(animationFrameRef.current)
    animationFrameRef.current = null
  }, [])

  const schedulePullDistance = useCallback(
    (next: number) => {
      distanceRef.current = next
      pendingDistanceRef.current = next

      const nextArmed = pullWillRefresh(next)
      if (nextArmed !== armedRef.current) {
        armedRef.current = nextArmed
        setArmed(nextArmed)
      }

      if (animationFrameRef.current !== null) return
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null
        paintPullDistance(pendingDistanceRef.current)
      })
    },
    [paintPullDistance],
  )

  const clearPullDistance = useCallback(() => {
    cancelScheduledFrame()
    distanceRef.current = 0
    pendingDistanceRef.current = 0
    if (armedRef.current) {
      armedRef.current = false
      setArmed(false)
    }
    if (!refreshing) paintPullDistance(0)
  }, [cancelScheduledFrame, paintPullDistance, refreshing])

  useEffect(() => {
    if (refreshing) {
      wasRefreshing.current = true
      clearPullDistance()
      setConfirmed(false)
      if (confirmationTimer.current) clearTimeout(confirmationTimer.current)
      return
    }
    if (!wasRefreshing.current) return
    wasRefreshing.current = false
    setConfirmed(true)
    confirmationTimer.current = setTimeout(() => setConfirmed(false), CONFIRMED_MS)
  }, [clearPullDistance, refreshing])

  useEffect(
    () => () => {
      cancelScheduledFrame()
      if (confirmationTimer.current) clearTimeout(confirmationTimer.current)
    },
    [cancelScheduledFrame],
  )

  const reset = useCallback(() => {
    pointer.current = null
    touch.current = null
    clearPullDistance()
  }, [clearPullDistance])

  const triggerRefresh = useCallback(() => {
    if (refreshTriggered.current || refreshing || !pullWillRefresh(distanceRef.current)) return
    refreshTriggered.current = true
    onRefresh()
  }, [onRefresh, refreshing])

  useEffect(() => {
    const boundary = boundaryRef.current
    if (!boundary) return

    // Safari and Chromium cancel PointerEvents once their scroll compositor
    // claims a vertical pan. A non-passive touch continuation is the standards
    // escape hatch: it keeps the same physical gesture alive and prevents only
    // a downward top-edge move, leaving ordinary mid-list scrolling untouched.
    const onTouchStart = (event: TouchEvent) => {
      const point = event.touches[0]
      if (!point) return
      const scrollElement = verticalScroller(event.target, boundary)
      if (!atTop(scrollElement)) return
      refreshTriggered.current = false
      touch.current = { id: point.identifier, startY: point.clientY, scrollElement }
    }
    const onTouchMove = (event: TouchEvent) => {
      const active = touch.current
      if (!active || !atTop(active.scrollElement)) return
      const point = Array.from(event.touches).find(
        (candidate) => candidate.identifier === active.id,
      )
      if (!point) return
      const rawDistance = point.clientY - active.startY
      if (rawDistance <= START_SLOP) {
        if (rawDistance < 0) reset()
        return
      }
      event.preventDefault()
      schedulePullDistance(resistedPullDistance(rawDistance - START_SLOP))
    }
    const onTouchEnd = (event: TouchEvent) => {
      const active = touch.current
      if (!active) return
      if (Array.from(event.touches).some((candidate) => candidate.identifier === active.id)) return
      triggerRefresh()
      reset()
    }

    boundary.addEventListener('touchstart', onTouchStart, { passive: true })
    boundary.addEventListener('touchmove', onTouchMove, { passive: false })
    boundary.addEventListener('touchend', onTouchEnd)
    boundary.addEventListener('touchcancel', reset)
    return () => {
      boundary.removeEventListener('touchstart', onTouchStart)
      boundary.removeEventListener('touchmove', onTouchMove)
      boundary.removeEventListener('touchend', onTouchEnd)
      boundary.removeEventListener('touchcancel', reset)
    }
  }, [reset, schedulePullDistance, triggerRefresh])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return
    const boundary = boundaryRef.current
    if (!boundary) return
    const scrollElement = verticalScroller(event.target, boundary)
    if (!atTop(scrollElement)) return
    refreshTriggered.current = false
    pointer.current = { id: event.pointerId, startY: event.clientY, scrollElement }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = pointer.current
    if (!active || active.id !== event.pointerId || !atTop(active.scrollElement)) return
    const rawDistance = event.clientY - active.startY
    if (rawDistance <= START_SLOP) {
      if (rawDistance < 0) reset()
      return
    }
    // The parallel non-passive touch listener keeps this physical gesture ours
    // if the browser later cancels PointerEvents. Prevent the pointer path too
    // so no compositor frame can rubber-band behind the indicator.
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    schedulePullDistance(resistedPullDistance(rawDistance - START_SLOP))
  }

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = pointer.current
    if (!active || active.id !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    pointer.current = null
    triggerRefresh()
    clearPullDistance()
  }

  const cancelPointer = () => {
    pointer.current = null
    // A physical touch continues through the non-passive listener above after
    // the browser cancels its PointerEvent. Do not erase that gesture's travel.
    if (!touch.current) clearPullDistance()
  }

  const visible = refreshing || confirmed
  const indicatorDistance = visible ? PULL_REFRESH_THRESHOLD : 0
  const label = refreshing
    ? connected
      ? 'Checking for updates…'
      : 'Reconnecting…'
    : confirmed
      ? connected
        ? 'Up to date'
        : 'Still offline'
      : armed
        ? 'Release to refresh'
        : 'Pull to refresh'
  const glyph = refreshing
    ? '↻'
    : confirmed && connected
      ? '✓'
      : confirmed
        ? '!'
        : armed
          ? '↑'
          : '↓'

  return (
    <div
      ref={boundaryRef}
      data-pull-to-refresh
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={cancelPointer}
      style={boundaryStyle}
    >
      <button type="button" aria-label="Refresh list" onClick={onRefresh} style={a11yButtonStyle}>
        Refresh list
      </button>
      <div
        ref={indicatorRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-pull-to-refresh-indicator
        style={{
          ...indicatorStyle,
          opacity: visible ? 1 : 0,
          transform: `translate(-50%, ${indicatorDistance - 42}px)`,
          transition: SETTLING_TRANSITION,
        }}
      >
        <span aria-hidden="true" style={glyphStyle}>
          {glyph}
        </span>
        {label}
      </div>
      {children}
    </div>
  )
}

const boundaryStyle = {
  position: 'relative',
  display: 'flex',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  overscrollBehaviorY: 'contain',
  touchAction: 'pan-y pinch-zoom',
} satisfies CSSProperties

const indicatorStyle = {
  ...mono(500),
  position: 'absolute',
  zIndex: 20,
  top: 0,
  left: '50%',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 30,
  padding: '0 11px',
  border: `1px solid ${color.borderStrong}`,
  borderRadius: radius.full,
  background: color.surfaceHigh,
  color: color.textDim,
  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)',
  fontSize: font.micro,
  lineHeight: '30px',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
} satisfies CSSProperties

const glyphStyle = {
  color: color.accentTint,
  fontSize: font.tiny,
  lineHeight: 1,
} satisfies CSSProperties

const a11yButtonStyle = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
} satisfies CSSProperties
