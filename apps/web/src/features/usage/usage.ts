import type { UsageBucketWire } from '@podium/model'

/**
 * Window math + API-cost-equivalent over the daemon's hour×model usage buckets.
 * Windows are rolling ("last 5h" / "last 7d") — Podium can't see the provider's
 * true quota anchor, so it shows consumption honestly instead of guessing limits.
 */

export interface UsageWindow {
  totalTokens: number
  outputTokens: number
  messages: number
  estCostUsd: number
}

export interface UsageSummaryView {
  fiveHour: UsageWindow
  week: UsageWindow
  /** Last 7 calendar days, oldest first: for the analytics bars. */
  days: { day: string; totalTokens: number; estCostUsd: number; messages: number }[]
  models: { model: string; totalTokens: number; estCostUsd: number; messages: number }[]
}

// Per-MTok API list prices (approximate; used as the "what this would have cost
// off-subscription" equivalence). Cache reads bill at 10% of input; cache
// writes at 125%. Substring matching keeps new model ids in the right family.
const PRICING: { match: string; inPerM: number; outPerM: number }[] = [
  { match: 'opus', inPerM: 15, outPerM: 75 },
  { match: 'sonnet', inPerM: 3, outPerM: 15 },
  { match: 'haiku', inPerM: 1, outPerM: 5 },
]
const DEFAULT_PRICING = { inPerM: 3, outPerM: 15 }

export function bucketCostUsd(b: UsageBucketWire): number {
  const p = PRICING.find((x) => b.model.includes(x.match)) ?? DEFAULT_PRICING
  return (
    (b.inputTokens / 1e6) * p.inPerM +
    (b.cacheCreationTokens / 1e6) * p.inPerM * 1.25 +
    (b.cacheReadTokens / 1e6) * p.inPerM * 0.1 +
    (b.outputTokens / 1e6) * p.outPerM
  )
}

const totalTokensOf = (b: UsageBucketWire): number =>
  b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens

function windowOver(buckets: UsageBucketWire[], sinceMs: number): UsageWindow {
  let totalTokens = 0
  let outputTokens = 0
  let messages = 0
  let estCostUsd = 0
  for (const b of buckets) {
    if (Date.parse(b.hour) < sinceMs) continue
    totalTokens += totalTokensOf(b)
    outputTokens += b.outputTokens
    messages += b.messages
    estCostUsd += bucketCostUsd(b)
  }
  return { totalTokens, outputTokens, messages, estCostUsd }
}

export function usageSummary(buckets: UsageBucketWire[], nowMs: number): UsageSummaryView {
  const fiveHour = windowOver(buckets, nowMs - 5 * 3_600_000)
  const week = windowOver(buckets, nowMs - 7 * 24 * 3_600_000)

  const dayMap = new Map<string, { totalTokens: number; estCostUsd: number; messages: number }>()
  for (let i = 6; i >= 0; i--) {
    dayMap.set(localDay(nowMs - i * 24 * 3_600_000), { totalTokens: 0, estCostUsd: 0, messages: 0 })
  }
  const modelMap = new Map<string, { totalTokens: number; estCostUsd: number; messages: number }>()
  for (const b of buckets) {
    // Attribute to the *local* calendar day. The bucket hour is UTC; slicing its
    // ISO string put evening work in a UTC-behind zone onto the wrong bar.
    const day = localDay(Date.parse(b.hour))
    const d = dayMap.get(day)
    if (d) {
      d.totalTokens += totalTokensOf(b)
      d.estCostUsd += bucketCostUsd(b)
      d.messages += b.messages
    }
    let m = modelMap.get(b.model)
    if (!m) {
      m = { totalTokens: 0, estCostUsd: 0, messages: 0 }
      modelMap.set(b.model, m)
    }
    m.totalTokens += totalTokensOf(b)
    m.estCostUsd += bucketCostUsd(b)
    m.messages += b.messages
  }
  return {
    fiveHour,
    week,
    days: [...dayMap.entries()].map(([day, v]) => ({ day, ...v })),
    models: [...modelMap.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
  }
}

/** Local-time `YYYY-MM-DD` (the user's calendar day, not UTC). */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** "1.2M" / "840k" / "312" token shorthand. */
export function formatTokens(n: number): string {
  // The ramp stopped at M, so a busy week printed "1000.0M" — four digits and a
  // unit that has stopped doing its job. The chart's axis is where it showed
  // first (its top tick is a rounded number, so it lands on 1000M exactly), but
  // the summary and the model table read the same scale and the same fix.
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

export function formatUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`
}

/**
 * A tick is a ruler mark, not a readout: it drops the decimal zero a value
 * keeps, so the axis reads 1B / 500M rather than 1.0B / 500.0M. `niceAxisMax`
 * only ever produces 1/2/5 × 10ⁿ, so a tick's decimal is always either absent
 * or a genuine half (2.5B), and only the zero is ever stripped.
 */
export function formatTick(n: number): string {
  return formatTokens(n).replace(/\.0(?=[kMB]?$)/, '')
}

/**
 * The top of a chart's y-axis: the smallest 1/2/5 × 10ⁿ at or above `peak`.
 *
 * A scale has to be readable, not merely correct — an axis topped at the raw
 * peak labels its gridlines 347.2M / 173.6M, which is three digits of noise per
 * line and a top gridline that means nothing but "the tallest bar". Snapping to
 * a round number makes every tick a number a person can hold, and leaves the
 * peak bar visibly short of the ceiling, which is itself information.
 */
export function niceAxisMax(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  const steps = [1, 2, 5, 10]
  for (const step of steps) {
    if (peak <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}
