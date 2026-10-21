import { machinePathBasename } from '@podium/model/browser'
import { TextQuote } from 'lucide-react'
import { type JSX, useCallback, useMemo, useState } from 'react'
import type { Quote, QuoteInput } from '@/lib/quote/quote-sinks'

/**
 * THE QUOTE STRIP (POD-2057) — passages on their way into the prompt, one chip
 * each, sitting where the words start so a chip reads as the head of the reply.
 *
 * Composer state, like attachments: nothing here is replicated, and a reload
 * starts the box empty. The text reaches the agent only at send, through
 * `serializeQuotes`.
 *
 * Staged per session for the life of the page, not the component: the composer
 * unmounts when its panel flips to the native view or the dock closes, and the
 * chips must be there when it comes back, as the draft is.
 */

let seq = 0
const staged = new Map<string, Quote[]>()

export interface UseQuotesResult {
  quotes: Quote[]
  add: (quote: QuoteInput) => void
  remove: (id: string) => void
  /** Backspace in an empty field takes the last chip, as in a token field. */
  removeLast: () => void
  clear: () => void
}

export function useQuotes(key: string): UseQuotesResult {
  const [state, setState] = useState(() => ({ key, quotes: staged.get(key) ?? [] }))
  // A composer reused for another session picks up THAT session's chips.
  if (state.key !== key) setState({ key, quotes: staged.get(key) ?? [] })
  const quotes = state.key === key ? state.quotes : (staged.get(key) ?? [])
  const update = useCallback(
    (next: (prev: Quote[]) => Quote[]) =>
      setState((prev) => {
        const quotes = next(prev.quotes)
        if (quotes.length) staged.set(prev.key, quotes)
        else staged.delete(prev.key)
        return { key: prev.key, quotes }
      }),
    [],
  )
  const add = useCallback(
    (quote: QuoteInput) => update((prev) => [...prev, { ...quote, id: `q${++seq}` }]),
    [update],
  )
  const remove = useCallback(
    (id: string) => update((prev) => prev.filter((q) => q.id !== id)),
    [update],
  )
  const removeLast = useCallback(() => update((prev) => prev.slice(0, -1)), [update])
  const clear = useCallback(() => update(() => []), [update])
  return useMemo(
    () => ({ quotes, add, remove, removeLast, clear }),
    [quotes, add, remove, removeLast, clear],
  )
}

const HEAD = 22

/** The chip names the file, not its directory; the full path is in the peek. */
function shortSource(source: string): string {
  return source.startsWith('/') ? machinePathBasename(source) : source
}

export function QuoteStrip({
  quotes,
  onRemove,
}: {
  quotes: readonly Quote[]
  onRemove: (id: string) => void
}): JSX.Element | null {
  if (quotes.length === 0) return null
  const numbered = quotes.length > 1
  return (
    <div className="quote-strip" data-testid="quote-strip">
      {quotes.map((quote, i) => (
        <span key={quote.id} className="quote-chip">
          {numbered ? (
            <span className="quote-chip-n">{i + 1}</span>
          ) : (
            <TextQuote size={13} className="text-text-dim" aria-hidden="true" />
          )}
          <span className="quote-chip-text">
            “{quote.text.length > HEAD ? `${quote.text.slice(0, HEAD - 2).trimEnd()}…` : quote.text}
          </span>
          <span className="quote-chip-source">{shortSource(quote.source)}</span>
          <button
            data-pressable
            type="button"
            className="quote-chip-remove"
            onClick={() => onRemove(quote.id)}
            aria-label="Remove quote"
          >
            ×
          </button>
          <span className="quote-chip-peek" role="tooltip">
            {quote.text}
            <cite>— {quote.source}</cite>
          </span>
        </span>
      ))}
    </div>
  )
}
