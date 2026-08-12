import type { ChatRow } from '@podium/client-core/viewmodels'

/**
 * WHEN A ROW HAPPENED (POD-701).
 *
 * The transcript carried timestamps on every item and rendered them on exactly
 * one surface — the narrow superagent dock — so the chat a reader actually
 * lives in never said when anything happened. These are the three answers the
 * feed needs, kept here (pure, DOM-free) rather than inline in the renderers so
 * the clock on a row and the day mark above it can never disagree about which
 * instant a row belongs to.
 *
 * Everything is LOCAL time. A transcript is read on the machine the reader is
 * sitting at, and "14:32" means the clock on their wall; an agent running on a
 * VPS in another zone is still reported in the reader's own.
 */

/** The instant a row belongs to: its item's `ts`, or the first item's in a run
 *  of folded tool calls. Undefined when the row carries no parseable time —
 *  older transcripts predate the field, and a wrong time is worse than none. */
export function rowTimestamp(row: ChatRow): Date | undefined {
  const ts = row.kind === 'tools' ? row.blocks[0]?.item.ts : row.block.item.ts
  return parseTs(ts)
}

/** A Date from an ISO timestamp, or undefined for absent/unparseable input. */
export function parseTs(ts: string | undefined): Date | undefined {
  if (!ts) return undefined
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** Local calendar day as a sortable `YYYY-MM-DD` key — the identity a day mark
 *  is keyed on. Deliberately not `toDateString()`, which is locale text. */
export function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** `14:32` — the row clock. Zero-padded 24h so the column stays one width; the
 *  tabular figures in `.chat-clk` do the rest. */
export function clockLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The day mark's text: `Today` / `Yesterday` for the two days a reader thinks
 *  of by name, an absolute date for everything else, carrying the year only
 *  when it is not the current one (a 2024 row in a 2026 session must not read
 *  as March). */
export function dayLabel(d: Date, now: Date): string {
  const key = dayKey(d)
  if (key === dayKey(now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (key === dayKey(yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** The full instant, for the `title` of a clock — the clock itself shows only
 *  hours and minutes, and a reader who needs the date or the seconds should not
 *  have to leave the row to get them. */
export function fullTimeLabel(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}
