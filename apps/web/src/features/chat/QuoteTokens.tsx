import type { JSX, RefObject } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Quote, QuoteInput } from '@/lib/quote/quote-sinks'
import { loadQuotes, saveQuotes } from '@/lib/quote/quote-store'
import { findTokens, uniqueLabel } from '@/lib/quote/quote-tokens'

/**
 * QUOTES IN THE PROMPT (POD-2057, inline since POD-2207). Each quote is a token
 * in the draft text (`quote-tokens.ts`); this file keeps the passages the
 * tokens stand for, and paints the tokens as pills behind the textarea.
 *
 * The passages are composer state, not replicated: the draft syncs, these stay
 * in this browser (`quote-store.ts`), so a reload or a composer that unmounts
 * (native view, closed dock) finds them again. Another device sees the token
 * and not the passage (an orphan).
 */

export interface UseQuotesResult {
  quotes: Quote[]
  /** Stage a passage and return it with its token. `draft` is the text it goes
   *  into: passages none of its tokens name any more are dropped here, and the
   *  labels of its orphans are not handed out again. */
  add: (quote: QuoteInput, draft: string) => Quote
  clear: () => void
}

let seq = 0

/** Mail forms use a local bank; their unsent text is not a synced prompt. */
export function useQuotes(key: string, persist = true): UseQuotesResult {
  const [state, setState] = useState(() => ({ key, quotes: persist ? loadQuotes(key) : [] }))
  // A composer reused for another session picks up THAT session's quotes.
  if (state.key !== key) setState({ key, quotes: persist ? loadQuotes(key) : [] })
  const quotes = state.key === key ? state.quotes : persist ? loadQuotes(key) : []
  const current = useRef({ key, quotes, persist })
  current.current = { key, quotes, persist }
  const add = useCallback((input: QuoteInput, draft: string): Quote => {
    const { key, quotes, persist } = current.current
    const named = new Set(findTokens(draft).map((t) => t.label))
    const kept = quotes.filter((q) => named.has(q.label))
    const staged = new Set(kept.map((q) => q.label))
    const orphans = new Set([...named].filter((label) => !staged.has(label)))
    const quote: Quote = {
      ...input,
      id: `q${Date.now().toString(36)}${++seq}`,
      label: uniqueLabel(input, kept, orphans),
    }
    const next = [...kept, quote]
    if (persist) saveQuotes(key, next)
    current.current = { key, quotes: next, persist }
    setState({ key, quotes: next })
    return quote
  }, [])
  const clear = useCallback(() => {
    const { key, persist } = current.current
    if (persist) saveQuotes(key, [])
    current.current = { key, quotes: [], persist }
    setState({ key, quotes: [] })
  }, [])
  return useMemo(() => ({ quotes, add, clear }), [quotes, add, clear])
}

/** What the overlay copies from the field so its text lays out the same. */
const MIRRORED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'fontVariant',
  'fontFeatureSettings',
  'fontVariationSettings',
  'fontKerning',
  'fontOpticalSizing',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'direction',
  'textRendering',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
  'hyphens',
] as const

/**
 * THE PILLS. A copy of the draft laid out exactly as the textarea lays it out,
 * sitting behind it, with every glyph transparent and each token wrapped in a
 * tinted mark. The textarea still draws all the text and the caret, so a pixel
 * of drift only moves a soft background, never the words.
 *
 * Nothing here is measured per frame. Wrapping follows the field's width in the
 * same layout pass (the copy is sized from it by a ResizeObserver, which runs
 * before paint), and scrolling past the cap moves the copy by the field's own
 * scroll event.
 */
export function QuoteOverlay({
  taRef,
  draft,
  quotes,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  quotes: readonly Quote[]
}): JSX.Element {
  const textRef = useRef<HTMLDivElement | null>(null)
  const tokens = useMemo(() => findTokens(draft), [draft])
  const known = useMemo(() => new Set(quotes.map((q) => q.label)), [quotes])
  const active = tokens.length > 0

  useLayoutEffect(() => {
    const ta = taRef.current
    const text = textRef.current
    if (!active || !ta || !text) return
    const place = (): void => {
      text.style.transform = `translate(${ta.clientLeft}px, ${ta.clientTop - ta.scrollTop}px)`
    }
    const fitToField = (): void => {
      const cs = getComputedStyle(ta)
      for (const prop of MIRRORED) text.style[prop] = cs[prop]
      text.style.width = `${ta.clientWidth}px`
      place()
    }
    fitToField()
    const ro = new ResizeObserver(fitToField)
    ro.observe(ta)
    ta.addEventListener('scroll', place, { passive: true })
    return () => {
      ro.disconnect()
      ta.removeEventListener('scroll', place)
    }
  }, [taRef, active])

  // A new line can scroll a capped field; follow it on the render that drew it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-place on every draft render
  useLayoutEffect(() => {
    const ta = taRef.current
    const text = textRef.current
    if (!active || !ta || !text) return
    text.style.transform = `translate(${ta.clientLeft}px, ${ta.clientTop - ta.scrollTop}px)`
  }, [draft, active])

  const parts: (string | JSX.Element)[] = []
  let at = 0
  for (const t of tokens) {
    parts.push(draft.slice(at, t.start))
    parts.push(
      <mark
        key={t.start}
        className="quote-token"
        data-orphan={known.has(t.label) ? undefined : 'true'}
      >
        {t.label}
      </mark>,
    )
    at = t.end
  }
  // A trailing newline still makes a line in the field; give the copy one too.
  if (active) parts.push(`${draft.slice(at)}\u200b`)

  return (
    <div className="quote-overlay" aria-hidden="true" data-testid="quote-overlay">
      <div ref={textRef} className="quote-overlay-text">
        {active ? parts : null}
      </div>
    </div>
  )
}
