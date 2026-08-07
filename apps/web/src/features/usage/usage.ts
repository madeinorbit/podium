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

/**
 * The four ways a token can be billed, cheapest first. The order is the ramp the
 * composition rails are drawn on, so it is data, not presentation: a class's
 * position IS its price tier, which is the whole point of showing token share
 * and cost share as two rails of the same four segments.
 */
export const TOKEN_CLASSES = ['cacheRead', 'cacheWrite', 'input', 'output'] as const
export type TokenClass = (typeof TOKEN_CLASSES)[number]

export interface UsageClassShare {
  key: TokenClass
  label: string
  tokens: number
  estCostUsd: number
}

/** One hour of the trace. `startMs` is the hour's local start. */
export interface UsageHour {
  startMs: number
  totalTokens: number
  estCostUsd: number
  messages: number
  /** This hour has not happened yet (the tail of today). Not the same as empty. */
  future: boolean
}

/** A local calendar day of the trace, carrying its own 24 hour slots. */
export interface UsageDay {
  day: string
  /** `Fri 07` — the trace's axis label. */
  label: string
  hours: UsageHour[]
  totalTokens: number
  estCostUsd: number
}

/**
 * Which vendor's price list a model bills against — derived from the model id
 * rather than carried on the wire, because the id names the family and the wire
 * does not name the harness. `claude-*` is Anthropic, `gpt-*`/`codex-*` OpenAI.
 * A model matching neither reads as `other` rather than being guessed into one.
 */
export type UsageProvider = 'anthropic' | 'openai' | 'other'

export interface UsageModelRow {
  model: string
  provider: UsageProvider
  totalTokens: number
  estCostUsd: number
  messages: number
}

export interface UsageSummaryView {
  fiveHour: UsageWindow
  week: UsageWindow
  /** Last 7 calendar days, oldest first, each with its 24 hour slots. */
  days: UsageDay[]
  /** The busiest single hour in the window — the trace's axis is scaled off it. */
  peakHourTokens: number
  /** Token share vs cost share of the four billing classes. */
  composition: UsageClassShare[]
  models: UsageModelRow[]
}

// Per-MTok API list prices (approximate; used as the "what this would have cost
// off-subscription" equivalence). Cache reads bill at 10% of input on both
// providers; cache writes at 125% (Anthropic — OpenAI doesn't bill them, and
// Codex reports the field as 0, so the term vanishes on its own).
//
// Substring matching keeps new model ids in the right family, which is what
// makes this table survive a release: `gpt-5.6-sol` and `gpt-5-codex` both land
// on the gpt-5 row. ORDER IS SIGNIFICANT — first match wins, so a narrower id
// has to precede the family it belongs to, or `gpt-5-mini` bills as `gpt-5`.
const PRICING: { match: string; inPerM: number; outPerM: number }[] = [
  { match: 'opus', inPerM: 15, outPerM: 75 },
  { match: 'sonnet', inPerM: 3, outPerM: 15 },
  { match: 'haiku', inPerM: 1, outPerM: 5 },
  { match: 'gpt-5-nano', inPerM: 0.05, outPerM: 0.4 },
  { match: 'gpt-5-mini', inPerM: 0.25, outPerM: 2 },
  { match: 'gpt-5', inPerM: 1.25, outPerM: 10 },
  // Codex's own model ids don't all carry the family name: its guardian
  // subagent bills as `codex-auto-review`, which without this row landed on the
  // Sonnet-priced fallback — 2.4x its likely rate, on a real share of the
  // machine's Codex traffic.
  { match: 'codex', inPerM: 1.25, outPerM: 10 },
]
const DEFAULT_PRICING = { inPerM: 3, outPerM: 15 }

/** The per-class cost of one bucket, in the order `TOKEN_CLASSES` names. */
function bucketCostByClass(b: UsageBucketWire): Record<TokenClass, number> {
  const p = PRICING.find((x) => b.model.includes(x.match)) ?? DEFAULT_PRICING
  return {
    cacheRead: (b.cacheReadTokens / 1e6) * p.inPerM * 0.1,
    cacheWrite: (b.cacheCreationTokens / 1e6) * p.inPerM * 1.25,
    input: (b.inputTokens / 1e6) * p.inPerM,
    output: (b.outputTokens / 1e6) * p.outPerM,
  }
}

export function bucketCostUsd(b: UsageBucketWire): number {
  const c = bucketCostByClass(b)
  return c.cacheRead + c.cacheWrite + c.input + c.output
}

const totalTokensOf = (b: UsageBucketWire): number =>
  b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens

/**
 * A record the harness wrote in place of a model reply — Claude Code stamps its
 * API-error and session-limit placeholders `<synthetic>`. They carry a usage
 * block of zeros and no model, so they add a permanent 0-token row to the model
 * table and inflate every reply count by however many times an agent hit a
 * limit. Dropped here as well as at the daemon's scanner (which is the real fix)
 * so an older daemon on another machine can't put the row back.
 */
const isSyntheticModel = (model: string): boolean => model.startsWith('<')

export function bucketProvider(model: string): UsageProvider {
  if (model.startsWith('claude')) return 'anthropic'
  if (model.startsWith('gpt') || model.includes('codex')) return 'openai'
  return 'other'
}

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

const CLASS_LABELS: Record<TokenClass, string> = {
  cacheRead: 'cache read',
  cacheWrite: 'cache write',
  input: 'input',
  output: 'output',
}

export function usageSummary(all: UsageBucketWire[], nowMs: number): UsageSummaryView {
  const buckets = all.filter((b) => !isSyntheticModel(b.model))
  const fiveHour = windowOver(buckets, nowMs - 5 * 3_600_000)
  const week = windowOver(buckets, nowMs - 7 * 24 * 3_600_000)

  // Seven local days of 24 hour slots, oldest first, keyed by the local hour
  // start so a bucket lands in the slot the operator's own clock would put it.
  const slots = new Map<number, UsageHour>()
  const days: UsageDay[] = []
  const hourNow = Math.floor(nowMs / 3_600_000) * 3_600_000
  for (let i = 6; i >= 0; i--) {
    const dayStart = startOfLocalDay(nowMs - i * 24 * 3_600_000)
    const hours: UsageHour[] = []
    for (let h = 0; h < 24; h++) {
      // Built by adding hours to local midnight rather than by index arithmetic
      // on the day start, so a DST day still lands 24 real slots on the clock.
      const startMs = addHours(dayStart, h)
      const slot: UsageHour = {
        startMs,
        totalTokens: 0,
        estCostUsd: 0,
        messages: 0,
        future: startMs > hourNow,
      }
      hours.push(slot)
      slots.set(startMs, slot)
    }
    days.push({ day: localDay(dayStart), label: dayLabel(dayStart), hours, totalTokens: 0, estCostUsd: 0 })
  }

  const composition: Record<TokenClass, { tokens: number; estCostUsd: number }> = {
    cacheRead: { tokens: 0, estCostUsd: 0 },
    cacheWrite: { tokens: 0, estCostUsd: 0 },
    input: { tokens: 0, estCostUsd: 0 },
    output: { tokens: 0, estCostUsd: 0 },
  }
  const modelMap = new Map<string, { totalTokens: number; estCostUsd: number; messages: number }>()
  for (const b of buckets) {
    const cost = bucketCostUsd(b)
    const tokens = totalTokensOf(b)
    // The bucket hour is UTC; the slot key is the local hour containing it.
    const slot = slots.get(Math.floor(Date.parse(b.hour) / 3_600_000) * 3_600_000)
    if (slot) {
      slot.totalTokens += tokens
      slot.estCostUsd += cost
      slot.messages += b.messages
    }
    const byClass = bucketCostByClass(b)
    composition.cacheRead.tokens += b.cacheReadTokens
    composition.cacheWrite.tokens += b.cacheCreationTokens
    composition.input.tokens += b.inputTokens
    composition.output.tokens += b.outputTokens
    for (const key of TOKEN_CLASSES) composition[key].estCostUsd += byClass[key]

    let m = modelMap.get(b.model)
    if (!m) {
      m = { totalTokens: 0, estCostUsd: 0, messages: 0 }
      modelMap.set(b.model, m)
    }
    m.totalTokens += tokens
    m.estCostUsd += cost
    m.messages += b.messages
  }

  let peakHourTokens = 0
  for (const d of days) {
    for (const h of d.hours) {
      d.totalTokens += h.totalTokens
      d.estCostUsd += h.estCostUsd
      if (h.totalTokens > peakHourTokens) peakHourTokens = h.totalTokens
    }
  }

  return {
    fiveHour,
    week,
    days,
    peakHourTokens,
    composition: TOKEN_CLASSES.map((key) => ({
      key,
      label: CLASS_LABELS[key],
      tokens: composition[key].tokens,
      estCostUsd: composition[key].estCostUsd,
    })),
    models: [...modelMap.entries()]
      .map(([model, v]) => ({ model, provider: bucketProvider(model), ...v }))
      // Ranked by cost, not tokens: the sheet leads with what the week would
      // have cost, and a table sorted on a different measure than the figure
      // above it reads as two answers to one question.
      .sort((a, b) => b.estCostUsd - a.estCostUsd),
  }
}

/** Local midnight of the day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** `ms` plus `h` hours on the wall clock (DST-safe, unlike +h×3600000). */
function addHours(ms: number, h: number): number {
  const d = new Date(ms)
  d.setHours(d.getHours() + h, 0, 0, 0)
  return d.getTime()
}

/** Local-time `YYYY-MM-DD` (the user's calendar day, not UTC). */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `Fri 07` — a weekday the eye can navigate by, over the bare date it needs. */
export function dayLabel(ms: number): string {
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}`
}

/** `03:00` — the hour a trace column covers, for its tooltip. */
export function formatHour(ms: number): string {
  return `${String(new Date(ms).getHours()).padStart(2, '0')}:00`
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

/** `34,929` — a count the eye can size at a glance rather than parse digit by digit. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

export function formatUsd(n: number): string {
  return n >= 100 ? `$${formatCount(Math.round(n))}` : `$${n.toFixed(2)}`
}

/** `97.3%` / `0.3%` — a share, at the one decimal that keeps a sliver from reading as zero. */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const pct = (part / whole) * 100
  if (pct === 0) return '0%'
  if (pct < 0.1) return '<0.1%'
  return `${pct.toFixed(1)}%`
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
 * The top of a chart's y-axis: the smallest round step at or above `peak`.
 *
 * A scale has to be readable, not merely correct — an axis topped at the raw
 * peak labels its gridlines 347.2M / 173.6M, which is three digits of noise per
 * line and a top gridline that means nothing but "the tallest bar". Snapping to
 * a round number makes every tick a number a person can hold, and leaves the
 * peak bar visibly short of the ceiling, which is itself information.
 *
 * The ramp is FINER than 1/2/5 (POD-596). On a 1/2/5 ramp a 350M peak takes a
 * 500M ceiling and throws away the top third of the plot — which on a trace of
 * mostly-short columns is the difference between a chart and a band of stubs.
 * Every step here still halves to something a person can read (400→200,
 * 250→125, 150→75), which is the only property the mid gridline needs.
 */
export function niceAxisMax(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  for (const step of steps) {
    if (peak <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}
