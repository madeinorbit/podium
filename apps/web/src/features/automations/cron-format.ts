/**
 * Cron ⇄ human, shared by the Scheduled cards and the composer (#470)
 * [spec:SP-17db]. Presentation only — the authoritative parse lives on the server
 * (modules/automations/cron.ts); this just prettifies the shapes the composer can
 * build, and falls back to the raw expression for anything hand-written.
 */

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export type Frequency = 'hourly' | 'daily' | 'weekly' | 'cron'

/**
 * Build a cron expression from the composer's schedule fields.
 *
 * An empty custom-cron box yields the EMPTY STRING — deliberately not a fallback
 * expression (#470). It used to fall back to `* * * * *`, which was harmless while
 * the tab was a mock and is a footgun now that it is real: Create on an untouched
 * cron box would arm an automation that spawns an agent session EVERY MINUTE. An
 * invalid expression must fail the composer's validity gate, not become a schedule
 * the operator never typed.
 */
export function cronFromFields(
  freq: Frequency,
  time: string,
  weekday: number,
  rawCron: string,
): string {
  if (freq === 'cron') return rawCron.trim()
  if (freq === 'hourly') return '0 * * * *'
  const [hRaw, mRaw] = time.split(':')
  const h = String(Number(hRaw ?? 0) || 0)
  const m = String(Number(mRaw ?? 0) || 0)
  if (freq === 'daily') return `${m} ${h} * * *`
  return `${m} ${h} * * ${weekday}`
}

/** minute, hour, day-of-month, month, day-of-week — the server parser's ranges. */
const FIELD_BOUNDS: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7], // 7 = Sunday
]

/** One field: `*`, `n`, `a-b`, `*<slash>s`, `a-b<slash>s`, `n<slash>s`, or a comma list of those. */
function validField(raw: string, min: number, max: number): boolean {
  return raw.split(',').every((part) => {
    const [range, step, ...rest] = part.split('/')
    if (rest.length > 0 || range === undefined) return false
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) === 0)) return false
    if (range === '*') return true
    const match = range.match(/^(\d+)(?:-(\d+))?$/)
    if (!match) return false
    const lo = Number(match[1])
    const hi = match[2] !== undefined ? Number(match[2]) : lo
    return lo >= min && hi <= max && lo <= hi
  })
}

/**
 * Does this parse as a 5-field cron? A CLIENT-SIDE MIRROR of the server's grammar
 * (apps/server/src/modules/automations/cron.ts) — it exists to keep Create disabled
 * on an empty or malformed box, so the operator sees the problem in the composer
 * instead of a round-trip error.
 *
 * The server stays authoritative: it re-parses and owns the explicit one-minute
 * floor. A floor violation comes back as a BAD_REQUEST and renders in the dialog's
 * error row.
 */
export function isValidCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  return parts.every((part, i) => {
    const bounds = FIELD_BOUNDS[i]
    return bounds !== undefined && validField(part, bounds[0], bounds[1])
  })
}

const pad = (n: string): string => n.padStart(2, '0')

/** A human sentence for the expressions the composer emits; the raw cron otherwise. */
export function cronSummary(cron: string): string {
  const [m, h, dom, month, dow] = cron.trim().split(/\s+/)
  if (!m || !h || !dom || !month || !dow) return cron
  if (dom !== '*' || month !== '*') return `Cron: ${cron}`
  if (m === '0' && h === '*' && dow === '*') return 'Hourly, on the hour'
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
    const at = `${pad(h)}:${pad(m)}`
    if (dow === '*') return `Daily at ${at}`
    if (/^[0-6]$/.test(dow)) return `Weekly on ${WEEKDAYS[Number(dow)]} at ${at}`
  }
  return `Cron: ${cron}`
}

/** Short local timestamp for a run / next-run line; '—' for null. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
