import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  type ChatRow,
  type MinimapTick,
  measureBlockOffsets,
  rowTickMeta,
  ticksFromOffsets,
} from './chat'

/**
 * Birds-eye strip: one tick per block, absolutely positioned by real DOM offsets
 * so ticks, the viewport box, and click-to-scroll all share one linear scroll
 * coordinate space (ratios of scrollHeight). User prompts pop in accent so
 * "where did I steer" reads at a glance. Click or drag to scrub.
 */
export function Minimap({
  rows,
  scrollerRef,
}: {
  rows: ChatRow[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
}): JSX.Element | null {
  const [ticks, setTicks] = useState<MinimapTick[]>([])
  const [viewport, setViewport] = useState({ top: 0, height: 1 })
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  // Re-measure DOM offsets after scroll, resize, or block list change.
  // We use rAF so the browser has laid out before we read offsetTop/offsetHeight.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let rafId: number | undefined

    const measure = () => {
      const total = el.scrollHeight || 1
      setViewport({ top: el.scrollTop / total, height: el.clientHeight / total })
      // The rendered [data-block] indices are ABSOLUTE into the full row list
      // (renderStart + ri) so scroll-to-match can target a row by its absolute
      // index. The minimap, though, only sees the windowed `rows` (0-based), so
      // rebase the measured offsets to the smallest rendered index before zipping
      // them with `rows.map(rowTickMeta)` — otherwise nothing lines up once the
      // window is scrolled past the start of the transcript (renderStart > 0).
      const offsets = measureBlockOffsets(el)
      const base = offsets.reduce((m, o) => Math.min(m, o.index), Infinity)
      const rebased = Number.isFinite(base)
        ? offsets.map((o) => ({ ...o, index: o.index - base }))
        : offsets
      setTicks(ticksFromOffsets(rows.map(rowTickMeta), rebased))
    }

    const schedMeasure = () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(measure)
    }

    schedMeasure()
    el.addEventListener('scroll', schedMeasure, { passive: true })
    const ro = new ResizeObserver(schedMeasure)
    ro.observe(el)
    return () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId)
      el.removeEventListener('scroll', schedMeasure)
      ro.disconnect()
    }
  }, [scrollerRef, rows])

  // Map a pointer Y on the strip to a scroll position, centring the viewport on
  // the pointer — so a click jumps there and a drag scrubs continuously.
  const scrubTo = (clientY: number) => {
    const el = scrollerRef.current
    const track = trackRef.current
    if (!el || !track) return
    const r = track.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientY - r.top) / (r.height || 1)))
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    el.scrollTop = Math.max(0, Math.min(max, f * el.scrollHeight - el.clientHeight / 2))
  }

  if (rows.length < 2) return null
  return (
    // The whole strip is the scrub surface; ticks are non-interactive colour
    // guides (pointer-events-none) so clicks/drags reach the track.
    <div
      ref={trackRef}
      className="relative my-1 mr-[3px] flex-[0_0_14px] cursor-pointer touch-none overflow-hidden rounded-[3px] bg-foreground/[0.04]"
      role="presentation"
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        scrubTo(e.clientY)
      }}
      onPointerMove={(e) => {
        if (dragging.current) scrubTo(e.clientY)
      }}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    >
      {ticks.map((tick) => (
        <div
          key={tick.index}
          className={cn(
            'pointer-events-none absolute inset-x-0 min-h-[2px]',
            // Priority of attention: user prompts > final answer > agent prose > tool/system.
            tick.role === 'user'
              ? 'bg-blue-500'
              : tick.answer
                ? 'bg-emerald-500'
                : tick.role === 'assistant'
                  ? 'bg-foreground/20'
                  : 'bg-foreground/[0.08]',
          )}
          style={{
            top: `${tick.top * 100}%`,
            height: `${Math.max(0.004, tick.height) * 100}%`,
          }}
        />
      ))}
      <div
        className="pointer-events-none absolute inset-x-0 rounded-[2px] border border-foreground/35 bg-foreground/15"
        style={{
          top: `${viewport.top * 100}%`,
          height: `${Math.max(0.04, viewport.height) * 100}%`,
        }}
      />
    </div>
  )
}
