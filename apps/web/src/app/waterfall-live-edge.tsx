import { observer } from 'mobx-react-lite'
import { createPortal } from 'react-dom'
import { useLayoutEffect, useState, useRef, type MutableRefObject, type RefObject } from 'react'
import type { WaterfallFrame } from './FlightDeckWaterfall'
import type { WaterfallView } from './waterfall-view'
import { useClock } from '@/lib/clock-hooks'
import {
  followWaterfallSessionViewport,
  waterfallBarGeometry,
  waterfallPercent,
  waterfallTicks,
  formatWaterfallDuration,
} from './flight-deck-waterfall'

/** Projection of a mounted lane's immutable history coordinates. No pool reads,
 * sorting, segment rebuilding, or history demand belongs to the clock leaf. */
export function projectWaterfallLane(lane: HTMLElement, frame: WaterfallFrame): void {
  const start = Number(lane.dataset.waterfallStart)
  const retainedEnd = Number(lane.dataset.waterfallEnd)
  const live = lane.dataset.waterfallLive === 'true'
  const end = live ? Math.max(start, frame.now) : retainedEnd
  const geometry = waterfallBarGeometry(start, end, frame.viewport)
  lane.style.setProperty('--waterfall-left', `${geometry.leftPct}%`)
  lane.style.setProperty(
    '--waterfall-width',
    `${lane.classList.contains('waterfall-history-lane') ? Math.max(2, geometry.widthPct) : geometry.widthPct}%`,
  )
  if (live) {
    lane.style.setProperty(
      '--waterfall-duration-ratio',
      String(Math.max(1, retainedEnd - start) / Math.max(1, end - start)),
    )
    for (const label of lane.querySelectorAll('.waterfall-session-time, .waterfall-bar-tag-time'))
      label.textContent = formatWaterfallDuration(end - start)
  }
  const contents = lane.querySelector<HTMLElement>('[data-waterfall-bar]')
  const marker = lane.querySelector<HTMLButtonElement>('.waterfall-offscreen')
  if (contents) contents.hidden = !geometry.visible
  if (marker) {
    marker.hidden = geometry.visible
    marker.dataset.side = geometry.leftPct === 0 ? 'start' : 'end'
    const bar = lane.querySelector<HTMLButtonElement>('.waterfall-session-bar')
    if (geometry.visible) marker.removeAttribute('data-flight-session')
    else if (bar?.dataset.flightSession) marker.dataset.flightSession = bar.dataset.flightSession
    if (geometry.visible) lane.removeAttribute('data-offscreen')
    else lane.dataset.offscreen = 'true'
    if (bar) {
      if (geometry.clippedStart) bar.dataset.clippedStart = 'true'
      else bar.removeAttribute('data-clipped-start')
    }
  }
}

/** The sole waterfall clock subscriber. Retained rows keep their MobX facts and
 * React trees; only mounted pixels and the live tail/ruler advance. Today's
 * coarse clock stays in place until POD-5863 supplies the demand clock. */
export const WaterfallLiveEdge = observer(function WaterfallLiveEdge({
  view,
  rootRef,
  frameRef,
  frame,
  following,
  future,
  window: _window,
}: {
  view: WaterfallView
  rootRef: RefObject<HTMLDivElement | null>
  frameRef: MutableRefObject<WaterfallFrame>
  frame: WaterfallFrame
  following: boolean
  future: boolean
  window: readonly unknown[]
}) {
  const lastNow = useRef(view.openedNow ?? 0)
  const manualNowPct = waterfallPercent(frame.viewport, lastNow.current)
  const watchClock =
    view.openedNow === null ||
    (following ? !view.followed?.settled : manualNowPct >= 0 && manualNowPct <= 100)
  const tick = useClock(1_000, watchClock)
  if (watchClock) lastNow.current = tick
  const now = lastNow.current
  const [targets, setTargets] = useState<{ labels: HTMLElement; lines: HTMLElement } | null>(null)
  const viewport = following
    ? followWaterfallSessionViewport(view.followed, now, frame.trackPx, { future })
    : frame.viewport
  const current = {
    ...frame,
    viewport,
    now,
    nowPct: waterfallPercent(viewport, now),
    msPerPx: (viewport.end - viewport.start) / Math.max(1, frame.trackPx),
  }
  const nowVisible = current.nowPct >= 0 && current.nowPct <= 100
  const edgePct = 1500 / Math.max(1, frame.trackPx)
  const ticks = waterfallTicks(viewport, frame.trackPx).filter(
    (tick) =>
      tick.pct > edgePct &&
      tick.pct < 100 - edgePct &&
      (!nowVisible || (Math.abs(tick.pct - current.nowPct) * frame.trackPx) / 100 > 26),
  )

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (view.openedNow === null) view.open(now)
    const labels = root.querySelector<HTMLElement>('.waterfall-axis-labels')
    const lines = root.querySelector<HTMLElement>('.waterfall-gridlines-track')
    if (!targets && labels && lines) setTargets({ labels, lines })
    frameRef.current = current
    root.style.setProperty('--waterfall-now', `${current.nowPct}%`)
    const nowLine = root.querySelector<HTMLElement>('.waterfall-now-line')
    if (nowLine) nowLine.hidden = !nowVisible
    for (const lane of root.querySelectorAll<HTMLElement>('[data-waterfall-start]'))
      projectWaterfallLane(lane, current)
    // A newly visible lane or a phase answer can repaint without waking the
    // parent. Project just that lane through the leaf's current frame.
    const repaint = (event: Event) => {
      const lane = (event as CustomEvent<HTMLElement>).detail
      if (lane instanceof HTMLElement && root.contains(lane)) projectWaterfallLane(lane, current)
    }
    root.addEventListener('waterfall-geometry', repaint)
    return () => root.removeEventListener('waterfall-geometry', repaint)
  })

  return targets ? (
    <>
      {createPortal(
        <>
          {ticks.map((tick) => (
            <span key={tick.at} className="waterfall-axis-tick" style={{ left: `${tick.pct}%` }}>
              {tick.label}
            </span>
          ))}
          {nowVisible ? (
            <span
              className="waterfall-axis-now"
              data-edge={(current.nowPct * frame.trackPx) / 100 > frame.trackPx - 26 || undefined}
              style={{ left: `${current.nowPct}%` }}
            >
              now
            </span>
          ) : null}
        </>,
        targets.labels,
      )}
      {createPortal(
        <>
          {ticks.map((tick) => (
            <span key={tick.at} style={{ left: `${tick.pct}%` }} />
          ))}
        </>,
        targets.lines,
      )}
    </>
  ) : null
})
