/**
 * ADD TO CHAT: WHERE A QUOTE CAN GO (POD-2057).
 *
 * Every mounted chat composer registers one sink. The selection layer asks this
 * module for a target only at the moment a selection settles, so nothing here
 * runs per keystroke or per frame.
 *
 * A sink counts only while its composer is on screen. Warm deck panels stay
 * mounted under `display:none`, which leaves them with no client rects, so they
 * drop out of every lookup without a visibility flag to keep in sync.
 */

/** One selected passage on its way into a prompt. `source` says where it came
 *  from in words the agent can act on: a file path with lines, or which message. */
export interface QuoteInput {
  text: string
  source: string
}

export interface Quote extends QuoteInput {
  id: string
}

export interface QuoteSink {
  /** The whole chat surface. A selection inside it goes to this sink's composer. */
  scope: HTMLElement
  /** The composer box itself: what must be visible for this sink to count. */
  composer: HTMLElement
  add: (quote: QuoteInput) => void
}

const sinks = new Set<QuoteSink>()
const focusedAt = new WeakMap<QuoteSink, number>()
let focusTick = 0

export function registerQuoteSink(sink: QuoteSink): () => void {
  sinks.add(sink)
  return () => {
    sinks.delete(sink)
  }
}

/** The composer took focus: it becomes the default target for selections made
 *  outside any chat (a file beside it, say). */
export function markQuoteSinkFocused(sink: QuoteSink): void {
  focusedAt.set(sink, ++focusTick)
}

function visible(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0
}

/**
 * The composer a selection at `from` should land in, or null when no prompt box
 * is on screen. A selection inside a chat goes to that chat; anywhere else, to
 * the visible composer focused most recently.
 */
export function resolveQuoteSink(from: Node): QuoteSink | null {
  let best: QuoteSink | null = null
  let bestAt = -1
  for (const sink of sinks) {
    if (!visible(sink.composer)) continue
    if (sink.scope.contains(from)) return sink
    const at = focusedAt.get(sink) ?? 0
    if (at > bestAt) {
      best = sink
      bestAt = at
    }
  }
  return best
}

/**
 * THE WIRE FORMAT, in one place. Quotes become Markdown blockquotes ahead of the
 * operator's words, each ending in its source, so nothing downstream (protocol,
 * daemon, transcript renderer) needs to know quotes exist. Several quotes are
 * numbered so the prose can say "1 is too long".
 */
export function serializeQuotes(quotes: readonly QuoteInput[], text: string): string {
  const numbered = quotes.length > 1
  const blocks = quotes.map((quote, i) => {
    const body = quote.text
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n')
    return `${numbered ? `[${i + 1}]\n` : ''}${body}\n> — ${quote.source}`
  })
  return [...blocks, text.trim()].filter(Boolean).join('\n\n')
}
