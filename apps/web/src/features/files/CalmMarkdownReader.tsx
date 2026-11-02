import type { MachineId, SessionId } from '@podium/model/browser'
import { Flower2 } from 'lucide-react'
import { marked } from 'marked'
import { type JSX, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { MarkdownPreview } from './MarkdownPreview'

/** Average silent-reading speed for the time-left estimate. */
const WORDS_PER_MINUTE = 230
/** A section counts as current once its heading rises above this line (px from the top). */
const ACTIVE_LINE = 120
/** Where a heading lands after a jump from the outline (px from the top). Above
 *  ACTIVE_LINE by less than a heading's own height, so the next heading can never
 *  also be over the line and take the highlight from the one just clicked. */
const JUMP_OFFSET = 96

type OutlineEntry = { id: string; text: string; level: 2 | 3 }

type ReadingPosition = {
  outline: OutlineEntry[]
  /** Index into `outline` of the section being read; -1 while still above the first. */
  active: number
  percent: number
  minutesLeft: number
  jumpTo: (index: number) => void
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length

/** Prose words in a Markdown source. Code is skimmed, not read, so every code
 *  token the renderer would produce (fenced, indented, nested in a list) is
 *  taken back out of the total. */
function proseWords(markdown: string): number {
  let words = wordCount(markdown)
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type === 'code') words -= wordCount(token.raw)
  })
  return Math.max(0, words)
}

/** The rendered h2/h3 headings a reader can actually reach: a heading with no
 *  box (`hidden`, a closed `<details>`) has nowhere to scroll to. */
function visibleHeadings(scroller: HTMLElement): HTMLElement[] {
  return [...scroller.querySelectorAll<HTMLElement>('h2, h3')].filter(
    (el) => el.getClientRects().length > 0,
  )
}

const sameOutline = (a: OutlineEntry[], b: OutlineEntry[]): boolean =>
  a.length === b.length && a.every((entry, i) => entry.id === b[i]?.id)

/** Tracks where the reader is in the rendered document: its h2/h3 outline, the
 *  current section, how far through the text the scroller is, and roughly how
 *  long is left. */
function useReadingPosition(
  scrollRef: RefObject<HTMLDivElement | null>,
  content: string,
): ReadingPosition {
  const headings = useRef<HTMLElement[]>([])
  /** The entry last jumped to and where the jump left the scroller. A jump to a
   *  late heading is clamped at the end, where it never reaches the active line,
   *  so the entry is held until the scroller moves from that spot by any means. */
  const jumped = useRef<{ index: number; top: number } | null>(null)
  const measureNow = useRef<() => void>(() => {})
  const [outline, setOutline] = useState<OutlineEntry[]>([])
  const [position, setPosition] = useState({ active: -1, percent: 0 })
  const words = useMemo(() => proseWords(content), [content])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `content` is the trigger — the preview has rendered it into the scroller before this effect runs
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return

    const resize = new ResizeObserver(() => schedule())
    let observed: Element[] = []
    /** Re-reads the headings and re-binds the size observer to the current
     *  blocks. Runs on open and whenever a block changes size, which is also when
     *  a collapsed section opens and its headings gain a box. */
    const refresh = (): void => {
      headings.current = visibleHeadings(scroller)
      const next = headings.current.map((el, i) => {
        const text = el.textContent?.trim() ?? ''
        return {
          id: `${i}:${text}`,
          text,
          level: el.tagName === 'H3' ? (3 as const) : (2 as const),
        }
      })
      setOutline((prev) => (sameOutline(prev, next) ? prev : next))
      // Re-bind only when the blocks themselves were replaced: observing a node
      // reports its size at once, and re-observing the same ones on every report
      // would loop.
      const blocks = [...scroller.children]
      if (blocks.length === observed.length && blocks.every((el, i) => el === observed[i])) return
      observed = blocks
      resize.disconnect()
      resize.observe(scroller)
      for (const block of blocks) resize.observe(block)
    }

    let frame = 0
    let stale = false
    const measure = (): void => {
      frame = 0
      if (stale || headings.current.some((el) => !el.isConnected)) refresh()
      stale = false
      // Progress runs to the end of the TEXT: the bottom padding that lets the
      // last lines rise off the bottom edge is not more document to read.
      const padding = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0
      const textMax = scroller.scrollHeight - padding - scroller.clientHeight
      const percent =
        textMax > 0 ? Math.min(100, Math.round((scroller.scrollTop / textMax) * 100)) : 100
      if (jumped.current && Math.abs(scroller.scrollTop - jumped.current.top) > 1)
        jumped.current = null
      const box = scroller.getBoundingClientRect()
      // At the very end the last sections can never rise to the active line, so
      // the line drops to the bottom edge: whatever heading is on screen last is
      // what the reader has reached.
      const atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1
      const line = atEnd ? box.bottom : box.top + ACTIVE_LINE
      let active = -1
      headings.current.forEach((el, i) => {
        if (el.getBoundingClientRect().top <= line) active = i
      })
      if (jumped.current) active = jumped.current.index
      setPosition((prev) =>
        prev.active === active && prev.percent === percent ? prev : { active, percent },
      )
    }
    function schedule(): void {
      stale = true
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measureNow.current = measure
    refresh()
    measure()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      measureNow.current = () => {}
    }
  }, [scrollRef, content])

  const jumpTo = (index: number): void => {
    const scroller = scrollRef.current
    const heading = headings.current[index]
    if (!scroller || !heading?.isConnected) return
    const offset = heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTo({ top: scroller.scrollTop + offset - JUMP_OFFSET })
    jumped.current = { index, top: scroller.scrollTop }
    // Move focus with the view, so the keyboard pages on from the destination
    // and a screen reader lands there too, rather than both staying in the margin.
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
    heading.focus({ preventScroll: true })
    // A clamped jump may not move the scroller at all, and then no scroll event
    // would ever arrive to show the new section as current.
    measureNow.current()
  }

  return {
    outline,
    active: position.active,
    percent: position.percent,
    minutesLeft: Math.ceil((words * (1 - position.percent / 100)) / WORDS_PER_MINUTE),
    jumpTo,
  }
}

/** A temporary reading surface above the live workspace. The document sits in a
 *  full-height column at reading width over the dimmed shell; on wide screens the
 *  margins either side carry the outline and the time left. */
export function CalmMarkdownReader({
  sessionId,
  worktree,
  path,
  content,
  onClose,
}: {
  sessionId: SessionId
  worktree?: { root: string; machineId?: MachineId }
  path: string
  content: string
  onClose: () => void
}): JSX.Element {
  const readerRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** A click only counts as on the backdrop if the press started there too: a
   *  text selection dragged out into the margin ends with a click on the layer. */
  const pressedBackdrop = useRef(false)

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    // Focus the scroller itself, so Space, PageDown and the arrow keys page the
    // document straight away; the browser never scrolls a focused element's
    // descendants.
    const scroller = scrollRef.current
    if (scroller) {
      scroller.tabIndex = -1
      scroller.focus({ preventScroll: true })
    } else readerRef.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      previousFocus?.focus({ preventScroll: true })
    }
  }, [onClose])

  // The dimmed margins are a third of a wide window. A wheel there scrolls the
  // document rather than doing nothing; the outline keeps its own scroll.
  useEffect(() => {
    const layer = readerRef.current
    if (!layer) return
    const onWheel = (event: WheelEvent): void => {
      const scroller = scrollRef.current
      const target = event.target as Element
      if (event.ctrlKey) return // pinch and ctrl-wheel zoom, not a scroll
      if (!scroller || scroller.contains(target) || target.closest?.('.calm-reader-outline')) return
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientHeight
            : 1
      scroller.scrollBy({ top: event.deltaY * unit })
    }
    layer.addEventListener('wheel', onWheel, { passive: true })
    return () => layer.removeEventListener('wheel', onWheel)
  }, [])

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on window above
    <div
      ref={readerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Calm reading: ${path}`}
      tabIndex={-1}
      className="calm-reader-layer"
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        const fromBackdrop = pressedBackdrop.current && event.target === event.currentTarget
        pressedBackdrop.current = false
        if (fromBackdrop && window.getSelection()?.isCollapsed !== false) onClose()
      }}
    >
      <section className="calm-reader-sheet">
        <header className="calm-reader-header">
          <div className="calm-reader-heading">
            <Flower2 size={15} aria-hidden="true" />
            <span>Calm reading</span>
          </div>
          <span className="calm-reader-path" title={path}>
            {path}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Leave calm reading mode"
            title="Leave calm reading mode — Esc"
          >
            <Flower2 size={15} aria-hidden="true" />
          </Button>
          <span className="calm-reader-hairline" aria-hidden="true" />
        </header>
        <MarkdownPreview
          sessionId={sessionId}
          {...(worktree ? { worktree } : {})}
          path={path}
          content={content}
          scrollRef={scrollRef}
          className="calm-reader-document"
        />
      </section>
      <CalmReaderMargins layerRef={readerRef} scrollRef={scrollRef} content={content} />
    </div>,
    document.body,
  )
}

/** The outline and time left. A separate component because it re-renders on
 *  scroll: kept out of the reader, those re-renders never reach the preview, so
 *  the document's nodes and any selection in them stay untouched while reading. */
function CalmReaderMargins({
  layerRef,
  scrollRef,
  content,
}: {
  layerRef: RefObject<HTMLDivElement | null>
  scrollRef: RefObject<HTMLDivElement | null>
  content: string
}): JSX.Element {
  const { outline, active, percent, minutesLeft, jumpTo } = useReadingPosition(scrollRef, content)

  // Written onto the layer so the narrow layout's header hairline reads it too.
  useEffect(() => {
    layerRef.current?.style.setProperty('--calm-progress', `${percent}%`)
  }, [layerRef, percent])

  return (
    <>
      {outline.length >= 2 && (
        <nav className="calm-reader-outline" aria-label="Sections">
          <span className="calm-reader-margin-label">Contents</span>
          <ol>
            {outline.map((entry, i) => (
              <li key={entry.id}>
                <button
                  type="button"
                  data-level={entry.level}
                  aria-current={i === active ? 'location' : undefined}
                  onClick={() => jumpTo(i)}
                >
                  {entry.text}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <aside className="calm-reader-progress" aria-label="Reading progress">
        <span className="calm-reader-track" aria-hidden="true" />
        <span className="calm-reader-time">
          {minutesLeft > 0 ? `${minutesLeft} min left` : 'End of document'}
        </span>
        <span className="calm-reader-percent">{percent}%</span>
      </aside>
    </>
  )
}
