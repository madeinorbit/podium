import type { Quote, QuoteInput } from './quote-sinks'

/**
 * INLINE QUOTE TOKENS (POD-2207) — a quote lives IN the prompt text, at the
 * place it was added, as a short token the composer paints as a pill.
 *
 * The prompt box stays a plain textarea, so a token has to be text. It is the
 * passage's head between ornament quotes, padded with no-break spaces that the
 * pill's background covers and that keep it on one line:
 *
 *     \u00A0❝Ich habe dir ein Da…❞
 *
 * The draft (which is synced) carries the token; the passage itself and its
 * source stay in the browser (`useQuotes`) and are looked up by the token's
 * text at send time. A token whose passage is not there — another device, a
 * cleared browser — is an ORPHAN: it still paints, dashed, and is sent as the
 * plain words it shows.
 */

const OPEN = '\u00A0❝'
const CLOSE = '❞\u00A0'
const HEAD = 20
const TOKEN = /\u00A0❝[^❝❞\n]*❞\u00A0/g

/** The token for a passage: its head, on one line, ornaments stripped. */
export function quoteLabel(text: string): string {
  const flat = text.replace(/[❝❞]/g, '').replace(/\s+/g, ' ').trim()
  const head = flat.length > HEAD ? `${flat.slice(0, HEAD - 1).trimEnd()}…` : flat
  return `${OPEN}${head.replace(/ /g, '\u00A0')}${CLOSE}`
}

/**
 * A label that names this passage and nothing else: not a staged quote with
 * other text or another source, and not an orphan already in the draft (which
 * would otherwise start expanding to this passage).
 */
export function uniqueLabel(
  quote: QuoteInput,
  staged: readonly Quote[],
  reserved: ReadonlySet<string> = new Set(),
): string {
  const base = quoteLabel(quote.text)
  const taken = (label: string): boolean =>
    reserved.has(label) ||
    staged.some((q) => q.label === label && (q.text !== quote.text || q.source !== quote.source))
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    const label = `${base.slice(0, -CLOSE.length)}\u00A0${n}${CLOSE}`
    if (!taken(label)) return label
  }
}

export interface TokenRange {
  start: number
  end: number
  label: string
}

export function findTokens(value: string): TokenRange[] {
  const out: TokenRange[] = []
  for (const m of value.matchAll(TOKEN))
    out.push({ start: m.index, end: m.index + m[0].length, label: m[0] })
  return out
}

/** The token a caret at `index` is strictly inside of, if any. */
export function tokenAround(value: string, index: number): TokenRange | null {
  return findTokens(value).find((t) => t.start < index && index < t.end) ?? null
}

/** The token Backspace at `caret` should take whole: one ending at or around it. */
export function tokenBefore(value: string, caret: number): TokenRange | null {
  return findTokens(value).find((t) => t.start < caret && caret <= t.end) ?? null
}

/** The token Delete at `caret` should take whole: one starting at or around it. */
export function tokenAfter(value: string, caret: number): TokenRange | null {
  return findTokens(value).find((t) => t.start <= caret && caret < t.end) ?? null
}

/**
 * Where a token goes and what surrounds it. A quote added at the end of a line
 * that already has words starts a line of its own, so "quote, then what I say
 * about it" reads down the box; one dropped mid-sentence stays where the caret
 * put it. A space follows, so typing carries straight on.
 */
export function placeToken(
  value: string,
  start: number,
  end: number,
  label: string,
): { insert: string; caret: number } {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const lineSoFar = before.slice(before.lastIndexOf('\n') + 1)
  const restOfLine = after.split('\n', 1)[0] ?? ''
  const newLine = lineSoFar.trim() !== '' && restOfLine.trim() === ''
  const prefix = newLine ? '\n' : ''
  const suffix = after.startsWith(' ') ? '' : ' '
  const insert = `${prefix}${label}${suffix}`
  return { insert, caret: start + insert.length }
}

/**
 * The tokens an edit cut into without removing whole, healed by removing the
 * rest of each. A soft keyboard's Backspace never reaches keydown with a usable
 * key, so this is where a phone's delete becomes atomic too.
 */
export function healTokens(prev: string, next: string): { value: string; caret: number } | null {
  if (next.length >= prev.length) return null
  let a = 0
  while (a < next.length && prev[a] === next[a]) a++
  let tail = 0
  while (tail < next.length - a && prev[prev.length - 1 - tail] === next[next.length - 1 - tail])
    tail++
  const b = prev.length - tail
  const broken = findTokens(prev).filter(
    (t) => t.start < b && t.end > a && !(t.start >= a && t.end <= b),
  )
  if (broken.length === 0) return null
  const from = Math.min(a, ...broken.map((t) => t.start))
  const to = Math.max(b, ...broken.map((t) => t.end))
  const inserted = next.slice(a, next.length - tail)
  return { value: prev.slice(0, from) + inserted + prev.slice(to), caret: from + inserted.length }
}

function blockquote(quote: QuoteInput): string {
  const body = quote.text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
  return `${body}\n> — ${quote.source}`
}

/** An orphan says what it shows, in plain quotes. */
function orphanText(label: string): string {
  return `“${label.slice(OPEN.length, -CLOSE.length).replace(/\u00A0/g, ' ')}”`
}

/**
 * THE WIRE FORMAT. Each token becomes its passage as a Markdown blockquote, in
 * place, ending in its source — so the agent reads each quote right before
 * what was said about it, and nothing downstream (protocol, daemon, transcript
 * renderer) needs to know quotes exist.
 */
export function serializeDraft(draft: string, quotes: readonly Quote[]): string {
  const tokens = findTokens(draft)
  if (tokens.length === 0) return draft.trim()
  const parts: string[] = []
  let at = 0
  let text = ''
  for (const t of tokens) {
    text += draft.slice(at, t.start)
    at = t.end
    const quote = findLast(quotes, (q) => q.label === t.label)
    if (!quote) {
      const pad = (ch: string | undefined): string => (ch && /\S/.test(ch) ? ' ' : '')
      text += `${pad(text.at(-1))}${orphanText(t.label)}${pad(draft[t.end])}`
      continue
    }
    parts.push(text, blockquote(quote))
    text = ''
  }
  parts.push(text + draft.slice(at))
  // Text sits at even indexes, quotes at odd ones. Text beside a quote loses the
  // whitespace that only separated it from the token.
  return parts
    .map((part, i) => (i % 2 ? part : (i > 0 ? part.replace(/^\s+/, '') : part).trimEnd()))
    .filter(Boolean)
    .join('\n\n')
}

function findLast<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i] as T)) return items[i]
  return undefined
}
