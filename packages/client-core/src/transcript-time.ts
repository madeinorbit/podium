/** Local calendar day as a sortable `YYYY-MM-DD` key — the identity a day mark
 *  is keyed on. Deliberately not `toDateString()`, which is locale text. */
export function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
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

/**
 * WHERE THE DATE CHANGES (POD-701) — mount position → the label to draw above
 * that row. Position-keyed rather than row-keyed because the mounted window is
 * the trailing slice of a much longer list and a row's identity says nothing
 * about which of its neighbours are on screen.
 *
 * The leading mark (`pos 0`) is emitted only when the window does not open on
 * today: "Today" above a transcript entirely from today is a line that tells
 * the reader nothing, while "Tue 5 Aug" above one from last week is the whole
 * point. Rows with no parseable timestamp are transparent — they neither draw a
 * mark nor reset the running day, so an older transcript that predates the
 * field degrades to no marks at all rather than to a mark on every row.
 */
export function dayMarksByPosition<T>(
  rows: Iterable<T>,
  now: Date,
  timestampOf: (row: T) => Date | undefined,
): Map<number, string> {
  const marks = new Map<number, string>()
  let running: string | undefined
  let pos = -1
  for (const row of rows) {
    pos += 1
    const at = timestampOf(row)
    if (!at) continue
    const key = dayKey(at)
    if (running === undefined) {
      if (key !== dayKey(now)) marks.set(pos, dayLabel(at, now))
    } else if (key !== running) {
      marks.set(pos, dayLabel(at, now))
    }
    running = key
  }
  return marks
}
