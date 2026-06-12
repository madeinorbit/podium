import type { UsageBucketWire } from '@podium/protocol'

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
    const day = new Date(nowMs - i * 24 * 3_600_000).toISOString().slice(0, 10)
    dayMap.set(day, { totalTokens: 0, estCostUsd: 0, messages: 0 })
  }
  const modelMap = new Map<string, { totalTokens: number; estCostUsd: number; messages: number }>()
  for (const b of buckets) {
    const day = b.hour.slice(0, 10)
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

/** "1.2M" / "840k" / "312" token shorthand. */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

export function formatUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`
}
