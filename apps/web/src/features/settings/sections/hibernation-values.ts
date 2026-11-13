/** The setting stays in minutes; the form reads and writes hours. */
export function backstopHours(minutes: number | null | undefined): number | null {
  return minutes == null ? null : minutes / 60
}

export function backstopMinutes(hours: number | null | undefined): number | null {
  return hours == null ? null : Math.round(Math.min(720, Math.max(1, hours)) * 60)
}
