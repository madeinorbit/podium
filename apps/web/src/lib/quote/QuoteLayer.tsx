import { type JSX, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { isApplePlatform } from '@/lib/mod-chord'
import { type QuoteInput, type QuoteSink, resolveQuoteSink } from './quote-sinks'

/**
 * ADD TO CHAT (POD-2057). Select a passage anywhere a source has marked itself
 * quotable and a pill offers to put it into the prompt box on screen.
 *
 * ONE LAYER FOR THE WHOLE APP, mounted once. It owns three passive document
 * listeners and does nothing until a pointer or Shift-key release leaves a
 * non-empty selection behind — no observers, no per-row components, and no
 * render of anything but the pill itself.
 *
 * Sources opt in with `data-quote-source="<what the agent should be told>"`. A
 * source rendered from Markdown blocks also carries `data-source-line` /
 * `data-source-end` on each block, which turns the label into a line range.
 * Surfaces whose DOM selection is not the truth (CodeMirror) register a
 * resolver instead, from their own lazy chunk.
 *
 * THE CHORD IS THE PROMPT'S OWN. While the pill is up, the chord that normally
 * focuses the prompt (⌘L in the macOS shell, ⌘/ or Ctrl+/ elsewhere) focuses it
 * with the selection attached. One chord, one meaning: "go to the prompt".
 */

/** A surface that knows its own selection better than the DOM does. Returns
 *  `undefined` when `el` is not its business, `null` when it is but holds nothing. */
export type QuoteResolver = (el: Element) => QuoteInput | null | undefined

const resolvers = new Set<QuoteResolver>()

export function registerQuoteResolver(resolver: QuoteResolver): () => void {
  resolvers.add(resolver)
  return () => {
    resolvers.delete(resolver)
  }
}

interface Pending {
  quote: QuoteInput
  sink: QuoteSink
  range: Range
}

const GAP = 8

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

function lineRange(source: HTMLElement, range: Range): string {
  const startEl = elementOf(range.startContainer)
  const endEl = elementOf(range.endContainer)
  const first = startEl?.closest<HTMLElement>('[data-source-line]')
  const last = endEl?.closest<HTMLElement>('[data-source-line]') ?? first
  if (!first || !last || !source.contains(first)) return ''
  const a = first.dataset.sourceLine
  const b = last.dataset.sourceEnd ?? last.dataset.sourceLine
  return a === b ? `:${a}` : `:${a}-${b}`
}

/** What the current selection would quote, or null when it is not quotable. */
export function readQuote(selection: Selection | null): { quote: QuoteInput; range: Range } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const el = elementOf(range.commonAncestorContainer)
  if (!el || el.closest('textarea, input')) return null
  for (const resolve of resolvers) {
    const quote = resolve(el)
    if (quote !== undefined) return quote ? { quote, range } : null
  }
  const source = el.closest<HTMLElement>('[data-quote-source]')
  const label = source?.dataset.quoteSource
  if (!source || !label) return null
  const text = selection
    .toString()
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) return null
  return { quote: { text, source: label + lineRange(source, range) }, range }
}

function isAddChord(e: KeyboardEvent): boolean {
  const mod = isApplePlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.altKey || e.shiftKey) return false
  return e.key === '/' || e.key.toLowerCase() === 'l'
}

type MenuGlobals = { __PODIUM_FOCUS_SESSION_PROMPT__?: () => void }

/** `chord` is the prompt-focus chord's label as the composer corner shows it. */
export function QuoteLayer({ chord }: { chord: string }): JSX.Element | null {
  const [shown, setShown] = useState(false)
  const pending = useRef<Pending | null>(null)
  const pillRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const globals = globalThis as MenuGlobals
    let frame = 0
    let menuHook: (() => void) | null = null
    let menuPrev: (() => void) | undefined

    // Above the first line of the selection, centred on the whole of it; below
    // when that would leave the viewport. Written straight to the node so a
    // scroll repositions without a render.
    const place = (): void => {
      const pill = pillRef.current
      const p = pending.current
      if (!pill || !p) return
      const all = p.range.getBoundingClientRect()
      if (all.bottom < 0 || all.top > window.innerHeight) {
        hide()
        return
      }
      const first = p.range.getClientRects()[0] ?? all
      const half = pill.offsetWidth / 2
      const below = first.top - pill.offsetHeight - GAP < GAP
      const x = Math.max(
        half + GAP,
        Math.min(all.left + all.width / 2, window.innerWidth - half - GAP),
      )
      pill.style.left = `${x}px`
      pill.style.top = `${below ? all.bottom + GAP : first.top - GAP}px`
      pill.dataset.below = below ? 'true' : 'false'
    }

    const hide = (): void => {
      if (!pending.current) return
      pending.current = null
      if (menuHook && globals.__PODIUM_FOCUS_SESSION_PROMPT__ === menuHook) {
        if (menuPrev) globals.__PODIUM_FOCUS_SESSION_PROMPT__ = menuPrev
        else delete globals.__PODIUM_FOCUS_SESSION_PROMPT__
      }
      menuHook = null
      setShown(false)
    }

    const add = (): void => {
      const p = pending.current
      if (!p) return
      hide()
      document.getSelection()?.removeAllRanges()
      p.sink.add(p.quote)
    }

    const check = (): void => {
      frame = 0
      const read = readQuote(document.getSelection())
      const sink = read ? resolveQuoteSink(read.range.commonAncestorContainer) : null
      if (!read || !sink) {
        hide()
        return
      }
      const wasShown = pending.current !== null
      pending.current = { ...read, sink }
      if (!wasShown) {
        // The macOS menu consumes ⌘L before the page sees a keydown; borrow its
        // hook for as long as the pill is up and hand it back after.
        menuPrev = globals.__PODIUM_FOCUS_SESSION_PROMPT__
        menuHook = add
        globals.__PODIUM_FOCUS_SESSION_PROMPT__ = add
      }
      setShown(true)
      place()
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(check)
    }

    const onPointerUp = (e: PointerEvent): void => {
      // Phones bring their own selection callout; the pill would sit on it.
      if (e.pointerType === 'touch') {
        hide()
        return
      }
      schedule()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Shift' || e.shiftKey) schedule()
    }
    const onSelectionChange = (): void => {
      if (pending.current && document.getSelection()?.isCollapsed !== false) hide()
    }
    // Capture, so the prompt-focus chord and CodeMirror's own Mod-l never see
    // the press that was meant for the pill.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!pending.current) return
      if (e.key === 'Escape') {
        hide()
        return
      }
      if (!isAddChord(e)) return
      e.preventDefault()
      e.stopPropagation()
      add()
    }
    const onScroll = (): void => {
      if (pending.current) place()
    }

    document.addEventListener('pointerup', onPointerUp, { passive: true })
    document.addEventListener('keyup', onKeyUp, { passive: true })
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    window.addEventListener('resize', onScroll, { passive: true })
    const pill = pillRef.current
    pill?.addEventListener('click', add)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      hide()
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      pill?.removeEventListener('click', add)
    }
  }, [])

  if (typeof document === 'undefined') return null
  return createPortal(
    <button
      ref={pillRef}
      type="button"
      className="quote-pill"
      data-shown={shown ? 'true' : undefined}
      data-testid="quote-pill"
      tabIndex={-1}
      aria-hidden={!shown}
      // Keep the selection: a press that moved focus would collapse it first.
      onPointerDown={(e) => e.preventDefault()}
    >
      Add to chat
      <kbd className="quote-pill-kbd">{chord}</kbd>
    </button>,
    document.body,
  )
}
