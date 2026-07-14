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

/** Build a cron expression from the composer's schedule fields. */
export function cronFromFields(
  freq: Frequency,
  time: string,
  weekday: number,
  rawCron: string,
): string {
  if (freq === 'cron') return rawCron.trim() || '* * * * *'
  if (freq === 'hourly') return '0 * * * *'
  const [hRaw, mRaw] = time.split(':')
  const h = String(Number(hRaw ?? 0) || 0)
  const m = String(Number(mRaw ?? 0) || 0)
  if (freq === 'daily') return `${m} ${h} * * *`
  return `${m} ${h} * * ${weekday}`
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
