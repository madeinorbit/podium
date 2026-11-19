import type { RoutedUiState } from '@podium/client-core/ui-state'
import type { Quote } from './quote-sinks'

/** Unsent passages belong to this member and workspace's device state. A send
 * clears its session, expiry bounds their lifetime, and account erase removes
 * the principal namespace. Unattributed raw keys from old builds are never read. */
export const QUOTES_KEY = 'podium.quotes.v1'
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
interface SavedQuotes {
  savedAt: number
  quotes: Quote[]
}
type Owner = Pick<RoutedUiState, 'get' | 'set'>
function isQuote(q: unknown): q is Quote {
  const v = q as Partial<Quote> | null
  return (
    typeof v?.id === 'string' &&
    typeof v.text === 'string' &&
    typeof v.source === 'string' &&
    typeof v.label === 'string'
  )
}
function bank(owner: Owner): Map<string, SavedQuotes> {
  try {
    const value: unknown = JSON.parse(owner.get(QUOTES_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map()
    const now = Date.now()
    return new Map(
      Object.entries(value).flatMap(([key, raw]) => {
        if (!raw || typeof raw !== 'object') return []
        const saved = raw as Partial<SavedQuotes>
        if (
          typeof saved.savedAt !== 'number' ||
          now - saved.savedAt > MAX_AGE_MS ||
          !Array.isArray(saved.quotes)
        )
          return []
        return [[key, { savedAt: saved.savedAt, quotes: saved.quotes.filter(isQuote) }] as const]
      }),
    )
  } catch {
    return new Map()
  }
}
function write(owner: Owner, quotes: Map<string, SavedQuotes>): void {
  owner.set(QUOTES_KEY, quotes.size ? JSON.stringify(Object.fromEntries(quotes)) : null)
}
export function loadQuotes(owner: Owner, key: string): Quote[] {
  return bank(owner).get(key)?.quotes ?? []
}
/** Called after mount; reads during render never write device state. */
export function sweepQuotes(owner: Owner): void {
  const current = bank(owner)
  const encoded = current.size ? JSON.stringify(Object.fromEntries(current)) : null
  if (owner.get(QUOTES_KEY) !== encoded) owner.set(QUOTES_KEY, encoded)
}
export function saveQuotes(owner: Owner, key: string, quotes: Quote[]): void {
  const current = bank(owner)
  if (quotes.length) current.set(key, { savedAt: Date.now(), quotes })
  else current.delete(key)
  write(owner, current)
}
