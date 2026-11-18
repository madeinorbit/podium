interface AgeLabel {
  text: string
  nextChangeAt: number
}

const invalid: AgeLabel = { text: '', nextChangeAt: Infinity }

function relativeAge(since: number, now: number): AgeLabel {
  if (!Number.isFinite(since)) return invalid
  // Preserve the formatter's successive rounding, including its half-second
  // boundary. Each inverse below follows those same rounding steps backwards.
  const s = Math.max(0, Math.round((now - since) / 1000))
  if (s < 60) return { text: 'just now', nextChangeAt: since + 59_500 }
  const m = Math.round(s / 60)
  if (m < 60) return { text: `${m}m ago`, nextChangeAt: since + ((m + 0.5) * 60 - 0.5) * 1000 }
  const h = Math.round(m / 60)
  if (h < 24)
    return {
      text: `${h}h ago`,
      nextChangeAt: since + (((h + 0.5) * 60 - 0.5) * 60 - 0.5) * 1000,
    }
  const d = Math.round(h / 24)
  return {
    text: `${d}d ago`,
    nextChangeAt: since + ((((d + 0.5) * 24 - 0.5) * 60 - 0.5) * 60 - 0.5) * 1000,
  }
}

/** "just now" / "5m ago" / "3h ago" / "2d ago", rounded as before. */
export function relativeTime(iso: string, now: number): string {
  return relativeAge(Date.parse(iso), now).text
}

/** First epoch millisecond at which relativeTime's answer changes. */
export function relativeTimeNextChangeAt(since: number, now: number): number {
  return relativeAge(since, now).nextChangeAt
}

function cardAgeLabel(since: number, now: number): AgeLabel {
  if (!Number.isFinite(since)) return invalid
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return { text: 'now', nextChangeAt: since + 60_000 }
  const m = Math.floor(s / 60)
  if (m < 60) return { text: `${m}m`, nextChangeAt: since + (m + 1) * 60_000 }
  const h = Math.floor(m / 60)
  if (h < 24) return { text: `${h}h`, nextChangeAt: since + (h + 1) * 3_600_000 }
  const d = Math.floor(h / 24)
  if (d < 7) return { text: `${d}d`, nextChangeAt: since + (d + 1) * 86_400_000 }
  const w = Math.floor(d / 7)
  if (w < 53) return { text: `${w}w`, nextChangeAt: since + (w + 1) * 7 * 86_400_000 }
  const y = Math.floor(d / 365)
  return { text: `${y}y`, nextChangeAt: since + (y + 1) * 365 * 86_400_000 }
}

/** Short whole-unit card stamp: "now", "12h", "3d", "6w". */
export function cardAge(iso: string, now: number): string {
  return cardAgeLabel(Date.parse(iso), now).text
}

/** First epoch millisecond at which cardAge's answer changes. */
export function cardAgeNextChangeAt(since: number, now: number): number {
  return cardAgeLabel(since, now).nextChangeAt
}
