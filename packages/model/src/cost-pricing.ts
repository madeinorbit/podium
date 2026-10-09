/** One token price table for server comparisons and client usage readouts. */
import type { UsageBucketWire } from './entities/machine'

/**
 * The four ways a token can be billed, CHEAPEST FIRST — the list-price ramp, so
 * the order is data rather than presentation: a class's position is its price
 * tier, which is the whole point of showing token share and cost share as two
 * rails of the same four segments.
 *
 * `cacheWrite` sat second here and did not belong there (POD-755): priced cache
 * writes cost 1.25x input for a 5-minute TTL and 2x for Anthropic's 1-hour TTL,
 * so a written cache token is the second most expensive kind, never the second
 * cheapest. The order claimed to be the ramp while stating the opposite of it,
 * and the sheet's cost-per-token column — which reads as a ramp or as noise,
 * nothing in between — printed 0.7x / 9.1x / 6.8x / 38x down the page.
 */
export const TOKEN_CLASSES = ['cacheRead', 'input', 'cacheWrite', 'output'] as const
export type TokenClass = (typeof TOKEN_CLASSES)[number]

/**
 * Which vendor's price list a model bills against — derived from the model id
 * rather than carried on the wire, because the id names the family and the wire
 * does not name the harness. `claude-*` is Anthropic, `gpt-*`/`codex-*` OpenAI,
 * `grok-*` is xAI. A model matching none of those reads as `other` rather than
 * being guessed into one.
 */
export type UsageProvider = 'anthropic' | 'openai' | 'xai' | 'other'

/**
 * Per-MTok API list price for one model family — the "what this would have cost
 * off-subscription" equivalence. All four billing classes are carried
 * EXPLICITLY rather than derived from the input rate by multiplier, because the
 * multipliers are not universal: Anthropic bills 5-minute writes at 1.25x input
 * and 1-hour writes at 2x, while OpenAI bills writes on the gpt-5.6 and gpt-6
 * families and NOT AT ALL on every other gpt-5.x. A single hardcoded rate
 * cannot represent those tiers. A rate of 0 is a statement the table makes
 * on purpose.
 */
export interface ModelPricing {
  match: string
  /** Which vendor bills this family — read by bucketProvider, so price and
   *  provider can never disagree about where a model belongs. */
  provider: UsageProvider
  inPerM: number
  outPerM: number
  cacheReadPerM: number
  /** 0 where the provider does not bill cache writes at all. */
  cacheWrite5mPerM: number
  /** Anthropic's extended-TTL write rate; equal to 5m where TTL is inapplicable. */
  cacheWrite1hPerM: number
}

/**
 * Substring matching keeps new model ids in the right family, which is what
 * makes this table survive a release. ORDER IS SIGNIFICANT — first match wins,
 * so a narrower id has to precede the family it belongs to, or `gpt-5-mini`
 * bills as `gpt-5` and `gpt-5.6-sol` bills as neither. The same holds for the
 * `-pro` tiers (`gpt-5.5-pro` contains `gpt-5.5`) and `fable-5-1` (contained
 * in `fable`): every narrow row sits ahead of its family.
 *
 * SOURCED FROM models.dev ON 2026-09-18 (an aggregator over the vendor lists,
 * not the lists themselves — cross-checked against the OpenAI / Anthropic /
 * xAI provider entries, which agree with each other where they overlap). This
 * supersedes the 2026-08-12 vendor-list verification, and moved the gpt-5.6
 * family DOWN: Sol $5/$30 → $4/$20, Terra $2.50/$15 → $2/$12,
 * Luna $1/$6 → $0.20/$1.20 with cache read/write $0.10/$1.25 → $0.02/$0.25.
 * Luna traffic was reading 5x high on every class. New since August: the
 * `-pro` tiers, `gpt-6-astra` ($10/$50) and `claude-fable-5-1` — whose cache
 * reads bill at $0.25, a quarter of fable-5's $1, so it gets its own row.
 *
 * Earlier history (POD-718 and below) is kept because it explains rows that
 * otherwise look arbitrary:
 *
 *  - `opus` sat at $15/$75, the retired Opus 4.1 tier. Every Opus this matches
 *    (5, 4.8, 4.7, 4.6, 4.5) lists at $5/$25, so every Anthropic figure on the
 *    sheet read 3x high — and Opus is nearly all of an agent fleet's traffic.
 *  - The whole gpt-5.6 family originally reached the `gpt-5` row at $1.25/$10
 *    by substring fallback. Its current tiers still span 20x from Sol ($4/$20)
 *    to Luna ($0.20/$1.20), so no single fallback rate can serve the family.
 *
 * The gpt-5.4, gpt-5.5, gpt-5.6 and gpt-6 families are priced in two context
 * bands: requests above 272K input tokens cost 2x on input and 1.5x on output.
 * The rows below are the SHORT band, because an hour x model bucket cannot
 * reconstruct the context size of the requests inside it — so long-context
 * work on those families is understated here, and knowingly so.
 */
const PRICING: ModelPricing[] = [
  // Fable-5.1's cache reads bill at $0.25, a quarter of fable-5's $1 — same
  // input/output, so only the read rate distinguishes the row. Narrower id
  // first: `claude-fable-5-1` also contains `fable`.
  {
    match: 'fable-5-1',
    provider: 'anthropic',
    inPerM: 10,
    outPerM: 50,
    cacheReadPerM: 0.25,
    cacheWrite5mPerM: 12.5,
    cacheWrite1hPerM: 20,
  },
  // Fable's id carries no family name the rows below would catch, so it fell
  // through to the Sonnet-priced fallback — 3.3x under its real rate, on a
  // model that gets reached for precisely on the expensive work.
  {
    match: 'fable',
    provider: 'anthropic',
    inPerM: 10,
    outPerM: 50,
    cacheReadPerM: 1,
    cacheWrite5mPerM: 12.5,
    cacheWrite1hPerM: 20,
  },
  {
    match: 'mythos',
    provider: 'anthropic',
    inPerM: 10,
    outPerM: 50,
    cacheReadPerM: 1,
    cacheWrite5mPerM: 12.5,
    cacheWrite1hPerM: 20,
  },
  {
    match: 'opus',
    provider: 'anthropic',
    inPerM: 5,
    outPerM: 25,
    cacheReadPerM: 0.5,
    cacheWrite5mPerM: 6.25,
    cacheWrite1hPerM: 10,
  },
  // Anthropic made the $2/$10 Sonnet 5 launch tier permanent on 2026-08-11.
  {
    match: 'sonnet-5',
    provider: 'anthropic',
    inPerM: 2,
    outPerM: 10,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 2.5,
    cacheWrite1hPerM: 4,
  },
  {
    match: 'sonnet',
    provider: 'anthropic',
    inPerM: 3,
    outPerM: 15,
    cacheReadPerM: 0.3,
    cacheWrite5mPerM: 3.75,
    cacheWrite1hPerM: 6,
  },
  {
    match: 'haiku',
    provider: 'anthropic',
    inPerM: 1,
    outPerM: 5,
    cacheReadPerM: 0.1,
    cacheWrite5mPerM: 1.25,
    cacheWrite1hPerM: 2,
  },
  // xAI short-context band. Same constraint as gpt-5.6: an hour×model bucket
  // cannot reconstruct prompt size, so the ≥200k doubling is omitted and
  // long-context Grok work is understated here, knowingly. Cache writes are
  // not a billed class on the published list; cached input is.
  {
    match: 'grok-4.6',
    provider: 'xai',
    inPerM: 2,
    outPerM: 6,
    cacheReadPerM: 0.5,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'grok-4.5',
    provider: 'xai',
    inPerM: 2,
    outPerM: 6,
    cacheReadPerM: 0.3,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'grok-4.3',
    provider: 'xai',
    inPerM: 1.25,
    outPerM: 2.5,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'grok-4.20-multi-agent',
    provider: 'xai',
    inPerM: 1.25,
    outPerM: 2.5,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'grok-4.20',
    provider: 'xai',
    inPerM: 1.25,
    outPerM: 2.5,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'grok-build',
    provider: 'xai',
    inPerM: 1,
    outPerM: 2,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  // The gpt-6 family, ahead of every `gpt-5` row below (no substring hazard —
  // `gpt-6-astra` contains no `gpt-5` id — but flagship first reads best).
  // The only OpenAI families that bill for cache writes are gpt-5.6 and gpt-6;
  // both carry a single write rate, so 5m and 1h are equal here.
  {
    match: 'gpt-6-astra',
    provider: 'openai',
    inPerM: 10,
    outPerM: 50,
    cacheReadPerM: 1,
    cacheWrite5mPerM: 12.5,
    cacheWrite1hPerM: 12.5,
  },
  // The gpt-5.6 family, narrowest first — and ahead of every `gpt-5` row below,
  // which all of these ids also contain. This is the only other OpenAI family
  // that bills for cache writes.
  {
    match: 'gpt-5.6-luna',
    provider: 'openai',
    inPerM: 0.2,
    outPerM: 1.2,
    cacheReadPerM: 0.02,
    cacheWrite5mPerM: 0.25,
    cacheWrite1hPerM: 0.25,
  },
  {
    match: 'gpt-5.6-terra',
    provider: 'openai',
    inPerM: 2,
    outPerM: 12,
    cacheReadPerM: 0.2,
    cacheWrite5mPerM: 2.5,
    cacheWrite1hPerM: 2.5,
  },
  {
    match: 'gpt-5.6-sol',
    provider: 'openai',
    inPerM: 4,
    outPerM: 20,
    cacheReadPerM: 0.4,
    cacheWrite5mPerM: 5,
    cacheWrite1hPerM: 5,
  },
  // The bare `gpt-5.6` alias routes to Sol, so it prices as Sol.
  {
    match: 'gpt-5.6',
    provider: 'openai',
    inPerM: 4,
    outPerM: 20,
    cacheReadPerM: 0.4,
    cacheWrite5mPerM: 5,
    cacheWrite1hPerM: 5,
  },
  // The `-pro` tiers each contain their family id (`gpt-5.5-pro` contains
  // `gpt-5.5`), so each precedes it — otherwise a pro request bills at the
  // base tier, 6-12x under. models.dev publishes no cache rates for the pro
  // tier; the read rate is derived at the OpenAI family-standard tenth of
  // input, and writes are 0 like every other non-5.6/6 OpenAI row.
  {
    match: 'gpt-5.5-pro',
    provider: 'openai',
    inPerM: 30,
    outPerM: 180,
    cacheReadPerM: 3,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5.5',
    provider: 'openai',
    inPerM: 5,
    outPerM: 30,
    cacheReadPerM: 0.5,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5.4-pro',
    provider: 'openai',
    inPerM: 30,
    outPerM: 180,
    cacheReadPerM: 3,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5.4-nano',
    provider: 'openai',
    inPerM: 0.2,
    outPerM: 1.25,
    cacheReadPerM: 0.02,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5.4-mini',
    provider: 'openai',
    inPerM: 0.75,
    outPerM: 4.5,
    cacheReadPerM: 0.075,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5.4',
    provider: 'openai',
    inPerM: 2.5,
    outPerM: 15,
    cacheReadPerM: 0.25,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  // Also catches `gpt-5.3-codex`, `gpt-5.3-codex-spark` and
  // `gpt-5.3-chat-latest`, which all list at this rate.
  {
    match: 'gpt-5.3',
    provider: 'openai',
    inPerM: 1.75,
    outPerM: 14,
    cacheReadPerM: 0.175,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5.2-pro',
    provider: 'openai',
    inPerM: 21,
    outPerM: 168,
    cacheReadPerM: 2.1,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5.2',
    provider: 'openai',
    inPerM: 1.75,
    outPerM: 14,
    cacheReadPerM: 0.175,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5.1',
    provider: 'openai',
    inPerM: 1.25,
    outPerM: 10,
    cacheReadPerM: 0.125,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  // `gpt-5-pro` contains the bare `gpt-5` id, so it precedes the three rows
  // below — otherwise it bills at $1.25/$10, 12x under its $15/$120 tier.
  {
    match: 'gpt-5-pro',
    provider: 'openai',
    inPerM: 15,
    outPerM: 120,
    cacheReadPerM: 1.5,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5-nano',
    provider: 'openai',
    inPerM: 0.05,
    outPerM: 0.4,
    cacheReadPerM: 0.005,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  {
    match: 'gpt-5-mini',
    provider: 'openai',
    inPerM: 0.25,
    outPerM: 2,
    cacheReadPerM: 0.025,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  // Also catches the retired `gpt-5-codex`, which billed at this rate.
  {
    match: 'gpt-5',
    provider: 'openai',
    inPerM: 1.25,
    outPerM: 10,
    cacheReadPerM: 0.125,
    cacheWrite5mPerM: 0,
    cacheWrite1hPerM: 0,
  },
  // NO BLANKET `codex` ROW. It existed to keep `codex-auto-review` off the
  // fallback, at a rate nobody could source — and OpenAI publishes no price for
  // that id anywhere. An invented number the sheet presents as list price is
  // worse than the fallback, because the fallback is the one thing the sheet
  // ADMITS TO: unpriced models are named in the provenance footer.
]

/**
 * What an unmatched model is charged, and a claim the sheet makes out loud —
 * `unpricedModels` puts every model that lands here in the footer, so the figure
 * is labelled as the guess it is rather than passing as a list price.
 */
const DEFAULT_PRICING: Omit<ModelPricing, 'match'> = {
  provider: 'other',
  inPerM: 3,
  outPerM: 15,
  cacheReadPerM: 0.3,
  cacheWrite5mPerM: 3.75,
  cacheWrite1hPerM: 6,
}

export function pricingForModel(model: string): {
  pricing: Omit<ModelPricing, 'match'>
  matched: boolean
} {
  const pricing = PRICING.find((x) => model.includes(x.match))
  return { pricing: pricing ?? DEFAULT_PRICING, matched: pricing !== undefined }
}

/** The per-class cost of one bucket, in the order `TOKEN_CLASSES` names. */
export function bucketCostByClass(b: UsageBucketWire): Record<TokenClass, number> {
  const p = pricingForModel(b.model).pricing
  const cacheCreation1hTokens = Math.min(b.cacheCreation1hTokens ?? 0, b.cacheCreationTokens)
  const cacheCreation5mTokens = b.cacheCreationTokens - cacheCreation1hTokens
  return {
    cacheRead: (b.cacheReadTokens / 1e6) * p.cacheReadPerM,
    cacheWrite:
      (cacheCreation5mTokens / 1e6) * p.cacheWrite5mPerM +
      (cacheCreation1hTokens / 1e6) * p.cacheWrite1hPerM,
    input: (b.inputTokens / 1e6) * p.inPerM,
    output: (b.outputTokens / 1e6) * p.outPerM,
  }
}

export function bucketCostUsd(b: UsageBucketWire): number {
  const c = bucketCostByClass(b)
  return c.cacheRead + c.cacheWrite + c.input + c.output
}

/**
 * What this bucket's cache reads would have cost at the model's full input rate,
 * less what they actually cost — the counterfactual the sheet reports as saved.
 *
 * Derived from the two RATES rather than from "cache reads are a tenth of
 * input, so the saving is nine times the charge". That identity holds for every
 * row in the table today and is exactly the kind of thing a future row breaks
 * silently, in the direction of overstating good news.
 */
export function bucketCacheSavingsUsd(b: UsageBucketWire): number {
  const p = pricingForModel(b.model).pricing
  return (b.cacheReadTokens / 1e6) * (p.inPerM - p.cacheReadPerM)
}

/**
 * Vendor fallback for model ids no priced row names (POD-4737): qualified
 * slug namespaces, mirroring the priced rows' convention. Bare harness kinds
 * never appear as matches — 'codex' and 'grok' would collide with the
 * HarnessAgent members the vendor-boundary lint gates, while the dashed
 * slugs name the model families the harvest actually reads. No rates live
 * here (the NO BLANKET `codex` ROW decision stands: unsourceable rates stay
 * callers' DEFAULT_PRICING, admitted in the footer) — only the vendor, so a
 * future grok id bills default rates under xai exactly as the prefix rule did.
 */
const UNPRICED_PROVIDER_FAMILIES: ReadonlyArray<{ match: string; provider: UsageProvider }> = [
  { match: 'codex-', provider: 'openai' },
  { match: 'grok-', provider: 'xai' },
]

export function bucketProvider(model: string): UsageProvider {
  // Family prefixes that can never collide with a harness kind stay prefix
  // rules; grok/codex families read off priced rows plus the qualified
  // fallbacks above, so adding a harness never needs a branch here. The day
  // one of these tokens becomes a harness kind, the vendor-boundary lint
  // starts counting it and this line lights up — self-reporting.
  if (model.startsWith('claude')) return 'anthropic'
  if (model.startsWith('gpt')) return 'openai'
  const priced = PRICING.find((x) => model.includes(x.match))
  if (priced) return priced.provider
  return UNPRICED_PROVIDER_FAMILIES.find((x) => model.includes(x.match))?.provider ?? 'other'
}

