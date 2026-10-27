import type { Quote } from './quote-sinks'

/**
 * WHERE STAGED PASSAGES LIVE (POD-2207). Per session, in memory and in
 * localStorage, so a reload keeps them. They hold text from the operator's
 * files and chats, so they are bounded three ways: a send clears them, a set
 * untouched for two weeks is swept, and erasing the account removes them all.
 */

const PREFIX = 'podium.quotes.'
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const memory = new Map<string, Quote[]>()
let swept = false

function isQuote(q: unknown): q is Quote {
  const v = q as Partial<Quote> | null
  return (
    typeof v?.id === 'string' &&
    typeof v.text === 'string' &&
    typeof v.source === 'string' &&
    typeof v.label === 'string'
  )
}

function sweep(now: number): void {
  if (swept) return
  swept = true
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue
      const savedAt = (
        JSON.parse(localStorage.getItem(key) ?? 'null') as { savedAt?: unknown } | null
      )?.savedAt
      if (typeof savedAt !== 'number' || now - savedAt > MAX_AGE_MS) localStorage.removeItem(key)
    }
  } catch {
    // Storage unavailable: nothing persisted to sweep.
  }
}

export function loadQuotes(key: string): Quote[] {
  const held = memory.get(key)
  if (held) return held
  sweep(Date.now())
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFIX + key) ?? 'null') as {
      quotes?: unknown
    } | null
    if (Array.isArray(parsed?.quotes)) {
      const quotes = parsed.quotes.filter(isQuote)
      memory.set(key, quotes)
      return quotes
    }
  } catch {
    // Storage unavailable or corrupt: start empty.
  }
  return []
}

export function saveQuotes(key: string, quotes: Quote[]): void {
  if (quotes.length) memory.set(key, quotes)
  else memory.delete(key)
  try {
    if (quotes.length) {
      localStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), quotes }))
    } else localStorage.removeItem(PREFIX + key)
  } catch {
    // Memory still holds them for this page.
  }
}

/** Every staged passage in this browser, for the account eraser. */
export function eraseAllQuotes(): void {
  memory.clear()
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(PREFIX)) localStorage.removeItem(key)
  } catch {
    // Nothing persisted.
  }
}
