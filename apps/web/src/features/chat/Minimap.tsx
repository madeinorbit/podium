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
 * THE TRANSCRIPT MAP (POD-413) — a barcode that now says what its bars are.
 *
 * The geometry is unchanged and still the good part: one tick per block,
 * absolutely positioned from real DOM offsets, so ticks, the viewport box and
 * click-to-scrub all live in ONE linear coordinate space (ratios of
 * scrollHeight). What was missing was meaning. Four greys and a blue with no
 * legend and no hover target is a texture, not an instrument — you could see
 * that something was there and never what.
 *
 * Two additions, both of which pay for the column:
 *
 *  LEGEND ON HOVER, NOT IN A CORNER. A static key would need a row of its own
 *  and would teach the mapping in the one place the eye is not. Instead the
 *  band under the pointer names itself — "You · reclaim the header", "Work ·
 *  Read ChatView, TranscriptFeed +3" — with a swatch in that band's own colour.
 *  The legend is therefore delivered exactly when it is asked for, tied to the
 *  colour it explains, and it doubles as a preview of where a scrub would land.
 *  Row titles come free: `ToolBatchRow.title` is the named work line the fold
 *  already computes (POD-376), so a work band reads as the work.
 *
 *  SEARCH LIVES HERE NOW. Search moved behind ⌘F, so the map is where match
 *  DISTRIBUTION is read: every matching band gets a Superade mark and the one
 *  under the cursor gets a full-width one. Closing the find bar no longer means
 *  losing sight of where the hits were — which is more integration than the
 *  permanent search row ever had.
 */

/** What a band means, in the reader's words, plus the swatch that teaches it. */
type BandKind = 'you' | 'answer' | 'agent' | 'work'
const BAND_WORD: Record<BandKind, string> = {
  you: 'You',
  answer: 'Answer',
  agent: 'Agent',
  work: 'Work',
}

interface Band {
  kind: BandKind
  /** The row's own words — a prompt, an answer, or the named work line. */
  text: string
}

/** One row's band: its kind (which colour) and the text the flyout shows. */
function rowBand(row: ChatRow): Band {
  if (row.kind === 'tools') return { kind: 'work', text: row.title }
  const { item } = row.block
  const text = (item.text ?? '').replace(/\s+/g, ' ').trim()
  if (item.role === 'user') return { kind: 'you', text }
  if (item.answer === true) return { kind: 'answer', text }
  if (item.role === 'assistant') return { kind: 'agent', text }
  return { kind: 'work', text }
}

/** Trim a band's text to flyout width without cutting mid-word where avoidable. */
function snippet(text: string, max = 68): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export function Minimap({
  rows,
  scrollerRef,
  matches = [],
  activeMatch,
}: {
  rows: ChatRow[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** Matching BLOCK indices from the search slice — marked on the map so the
   *  spread of hits stays visible with the find bar closed. */
  matches?: readonly number[]
  /** The block index under the match cursor, marked more strongly. */
  activeMatch?: number | undefined
}): JSX.Element | null {
  const [ticks, setTicks] = useState<MinimapTick[]>([])
  const [viewport, setViewport] = useState({ top: 0, height: 1 })
  const [hover, setHover] = useState<{ row: number; at: number } | null>(null)
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

  /** Pointer Y → ratio of the track, which IS the ratio of scrollHeight. */
  const ratioAt = (clientY: number): number | null => {
    const track = trackRef.current
    if (!track) return null
    const r = track.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientY - r.top) / (r.height || 1)))
  }

  // Map a pointer Y on the strip to a scroll position, centring the viewport on
  // the pointer — so a click jumps there and a drag scrubs continuously.
  const scrubTo = (clientY: number) => {
    const el = scrollerRef.current
    const f = ratioAt(clientY)
    if (!el || f === null) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    el.scrollTop = Math.max(0, Math.min(max, f * el.scrollHeight - el.clientHeight / 2))
  }

  // Which band is under the pointer. Ticks are laid out in the same ratio space,
  // so this is a containment test; a pointer in the gap between two short blocks
  // falls back to the nearest band above it rather than blanking the flyout.
  const bandAt = (clientY: number) => {
    const f = ratioAt(clientY)
    if (f === null) return
    let found: MinimapTick | undefined
    for (const tick of ticks) {
      if (tick.top > f) break
      found = tick
    }
    const hit = ticks.find((t) => f >= t.top && f <= t.top + t.height) ?? found
    setHover(hit ? { row: hit.index, at: f } : null)
  }

  if (rows.length < 2) return null

  // Search marks are computed from BLOCK indices, not row positions, so nothing
  // here depends on where the render window happens to start.
  const matchSet = new Set(matches)
  const rowMatch = (i: number): 'active' | 'match' | null => {
    const row = rows[i]
    if (!row || matchSet.size === 0) return null
    const indices = row.kind === 'tools' ? row.blockIndices : [row.blockIndex]
    if (activeMatch !== undefined && indices.includes(activeMatch)) return 'active'
    return indices.some((b) => matchSet.has(b)) ? 'match' : null
  }

  const hoveredBand = hover ? rows[hover.row] : undefined
  const band = hoveredBand ? rowBand(hoveredBand) : null

  return (
    <div className="minimap">
      {/* The whole strip is the scrub surface; ticks are non-interactive colour
          guides (pointer-events-none) so clicks/drags reach the track. */}
      <div
        ref={trackRef}
        className="minimap-track"
        role="presentation"
        title="Transcript map — click or drag to scrub. Hover a band to see what it is."
        onPointerDown={(e) => {
          e.preventDefault()
          dragging.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          scrubTo(e.clientY)
        }}
        onPointerMove={(e) => {
          if (dragging.current) scrubTo(e.clientY)
          bandAt(e.clientY)
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={() => {
          dragging.current = false
        }}
        onPointerCancel={() => {
          dragging.current = false
          setHover(null)
        }}
      >
        {ticks.map((tick) => {
          const kind = rowBand(rows[tick.index] as ChatRow).kind
          return (
            <div
              key={tick.index}
              // Priority of attention: your prompts > the final answer > agent
              // prose > tool/system — carried by WIDTH as well as by hue, so the
              // shape of a session is readable before any colour is decoded (and
              // still readable if colour isn't available to the reader at all).
              className={cn(
                'minimap-tick',
                `minimap-tick--${kind}`,
                hover?.row === tick.index && 'minimap-tick--hover',
              )}
              style={{
                top: `${tick.top * 100}%`,
                height: `${Math.max(0.004, tick.height) * 100}%`,
              }}
            />
          )
        })}
        {/* Search marks are an OVERLAY on the right edge, not a recolouring: a
            hit is orthogonal to what the band is, and a reader mid-search should
            still be able to see that the thing they found is an answer. */}
        {ticks.map((tick) => {
          const mark = rowMatch(tick.index)
          if (!mark) return null
          return (
            <div
              key={`m${tick.index}`}
              className={cn('minimap-mark', mark === 'active' && 'minimap-mark--active')}
              style={{
                top: `${tick.top * 100}%`,
                height: `${Math.max(0.004, tick.height) * 100}%`,
              }}
            />
          )
        })}
        <div
          className="minimap-view"
          style={{
            top: `${viewport.top * 100}%`,
            height: `${Math.max(0.04, viewport.height) * 100}%`,
          }}
        />
      </div>
      {/* The legend, delivered where it is asked for: the word names the colour
          under the pointer, the text names that particular band. */}
      {band && (
        <div className="minimap-flyout" style={{ top: `${(hover?.at ?? 0) * 100}%` }}>
          <span className={cn('minimap-swatch', `minimap-tick--${band.kind}`)} aria-hidden="true" />
          <span className="minimap-flyout-kind">{BAND_WORD[band.kind]}</span>
          {band.text && <span className="minimap-flyout-text">{snippet(band.text)}</span>}
        </div>
      )}
    </div>
  )
}
