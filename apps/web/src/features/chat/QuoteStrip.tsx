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
 */

let seq = 0

export interface UseQuotesResult {
  quotes: Quote[]
  add: (quote: QuoteInput) => void
  remove: (id: string) => void
  /** Backspace in an empty field takes the last chip, as in a token field. */
  removeLast: () => void
  clear: () => void
}

export function useQuotes(): UseQuotesResult {
  const [quotes, setQuotes] = useState<Quote[]>([])
  const add = useCallback((quote: QuoteInput) => {
    setQuotes((prev) => [...prev, { ...quote, id: `q${++seq}` }])
  }, [])
  const remove = useCallback((id: string) => {
    setQuotes((prev) => prev.filter((q) => q.id !== id))
  }, [])
  const removeLast = useCallback(() => setQuotes((prev) => prev.slice(0, -1)), [])
  const clear = useCallback(() => setQuotes([]), [])
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
