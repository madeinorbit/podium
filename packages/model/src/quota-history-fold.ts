/**
 * FOLDING QUOTA SAMPLES INTO WINDOW INSTANCES.
 *
 * A provider tells us three things about a rolling limit: how much of it is
 * spent, when it resets, and (sometimes) how long it runs. It does NOT tell us
 * which run of the window we are looking at — there is no window id, no sequence
 * number, no start. So "is this the same window I saw a minute ago, or a new one?"
 * has to be decided here, from the numbers alone.
 *
 * THE TRAP THIS EXISTS TO AVOID. `resetsAt` is not stable. Anthropic and OpenAI
 * both appear to compute it as `now + time remaining`, so it JITTERS between
 * fetches — sub-second for Claude, a whole second for Codex — and it moves in
 * BOTH directions, including across a minute boundary. Measured on one machine,
 * 2026-08-24:
 *
 *   claude-code weekly-all   01:00:00.039 → 00:59:59.325 → 00:59:59.714
 *   codex       weekly       07:00:43.000 → 07:00:44.000 → 07:00:43.000
 *   grok        weekly       12:35:22.333410  (stable across every sample)
 *
 * Keying an instance on `resetsAt` matched exactly — the obvious design — would
 * mint a brand-new window on EVERY sample for two of the three harnesses, and the
 * ledger would draw one column per poll instead of one per reset. Rounding to a
 * unit does not fix it either; it just moves the split to the rarer case where the
 * jitter straddles the rounding boundary, which the trace above actually does.
 *
 * SO IDENTITY IS TOLERANT, and it rests on two signals rather than one.
 *
 * The primary signal is `resetsAt` MOVING BY MORE THAN THE JITTER. At a real reset
 * the reset time shifts by about one whole window — structural, not a convention.
 * Observed at a real rollover, the percentage moves with it:
 *
 *   11:01:40Z  12%  resets 11:00:00.097
 *   11:02:42Z   1%  resets 16:00:00.504   ← exactly one window duration on
 *
 * The second signal is a LARGE FALL in `usedPercent`, and it is needed because the
 * first one is not universal. A provider whose reset time tracks when the oldest
 * usage ages out, rather than a fixed boundary, can empty its pool while its reset
 * time merely creeps — no advance large enough to notice, but the pool plainly
 * started over. See `RESET_DROP_PP` for where that threshold comes from.
 *
 * Ordinary within-window movement trips neither: small decreases are a rolling
 * window shedding old turns, and `peakPercent` absorbs them.
 *
 * AND ONE THING THAT LOOKS LIKE A RESET AND IS NOT. The same rolling anchor that
 * makes the second signal necessary degenerates to `now + window` once the pool
 * is EMPTY: with no oldest usage to age out, the reset time simply tracks the
 * clock. Sampled every fifteen minutes it then advances fifteen minutes a poll,
 * past the tolerance, and the first signal fires on a window that never ended.
 * `isCreep` is the exemption, and it turns on the advance measured AGAINST
 * ELAPSED TIME rather than against zero.
 */

import type { AgentKind } from './entities/agent'

/** One reading of one window, as it arrives from a provider. */
export interface QuotaSample {
  accountKey: string
  agent: AgentKind
  windowKey: string
  label: string
  scopeModel?: string | undefined
  plan?: string | undefined
  usedPercent: number
  /** Epoch ms. Callers drop samples whose `resetsAt` was unparsable — an
   *  unidentifiable window cannot be folded into a series. */
  resetsAtMs: number
  windowMinutes: number
  /** When this reading was taken, epoch ms. */
  atMs: number
  source: 'live' | 'backfill'
}

/** The stored state of one window instance, as the fold reads and rewrites it. */
export interface QuotaWindowInstance {
  accountKey: string
  agent: AgentKind
  windowKey: string
  label: string
  scopeModel?: string | undefined
  plan?: string | undefined
  resetsAtMs: number
  startedAtMs?: number | undefined
  windowMinutes: number
  firstSeenMs: number
  lastSeenMs: number
  firstPercent: number
  peakPercent: number
  lastPercent: number
  sampleCount: number
  partial: boolean
  source: 'live' | 'backfill'
  /** `[minutesFromStart, percent]`, oldest first — the burn curve. Decimated to
   *  `TRAIL_MAX_POINTS` so a weekly row stays small. */
  trail: [number, number][]
}

/**
 * How far apart two `resetsAt` readings may be and still be the same window.
 *
 * Five minutes is four orders of magnitude above the largest jitter measured
 * (1 s) and far below the smallest gap between adjacent windows (5 h), so it
 * separates the two cases with enormous margin. The `windowMs / 4` clamp keeps
 * that true if a provider ever ships a window shorter than 20 minutes.
 */
export const RESET_TOLERANCE_MS = 5 * 60 * 1000

export function resetToleranceMs(windowMinutes: number): number {
  if (windowMinutes <= 0) return RESET_TOLERANCE_MS
  return Math.min(RESET_TOLERANCE_MS, (windowMinutes * 60_000) / 4)
}

/** Cap on stored burn-curve points. 240 over a week is a point every ~42 min. */
export const TRAIL_MAX_POINTS = 240

/**
 * A fall in `usedPercent` this large is a reset, whatever the reset time says.
 *
 * The reset-time advance above is the primary signal and is enough for a
 * fixed-anchor window. It is not enough everywhere: a provider whose reset time
 * creeps (because it tracks when the oldest usage ages out rather than a fixed
 * boundary) can empty its pool without the advance ever exceeding the tolerance.
 * The percentage is unambiguous when that happens.
 *
 * 25 points is measured, not chosen by feel. Across 7,370 real Codex readings the
 * decreases are sharply bimodal — 2,587 of 0–2 points (ordinary oscillation), 54
 * scattered between 2 and 20, and 400 above 40 (pools emptying) — so the
 * threshold sits in an empty valley rather than cutting through a cluster.
 */
export const RESET_DROP_PP = 25

/**
 * Does this sample continue `instance`, or belong to a different window?
 *
 * THE COMPARISON IS TWO-SIDED, and getting that wrong is not a small error. An
 * earlier version tested only `sample - instance <= tolerance`, reasoning that a
 * reset time falling behind is the backwards half of the jitter. It is — for
 * jitter, which is under a second. But the same test also answers "yes, same
 * window" to a sample from SIX WEEKS ago, and backfill is made entirely of those:
 * the sampler writes the current window first, then every recovered sample is
 * absorbed into it. That loses all history AND corrupts the live row, which ends
 * up claiming a peak from a window that closed a fortnight earlier.
 *
 * Absolute distance keeps the jitter tolerance (sub-second drift is far inside
 * five minutes) while letting a genuinely older window be recognised as one.
 */
export function isSameInstance(instance: QuotaWindowInstance, sample: QuotaSample): boolean {
  // A pool that emptied has started over, even if its reset time barely moved.
  // Checked first: it is the unambiguous signal, and the reset-time test below
  // cannot see this case at all when the provider's reset time creeps.
  if (
    sample.atMs >= instance.lastSeenMs &&
    sample.usedPercent < instance.lastPercent - RESET_DROP_PP
  ) {
    return false
  }
  const windowMinutes = sample.windowMinutes || instance.windowMinutes
  const tolerance = resetToleranceMs(windowMinutes)
  if (Math.abs(sample.resetsAtMs - instance.resetsAtMs) <= tolerance) return true
  return isCreep(instance, sample, windowMinutes, tolerance)
}

/**
 * A ROLLING ANCHOR TRACKS *NOW*, AND MUST NOT BE READ AS A RESET.
 *
 * Codex computes `resetsAt` from when the oldest usage will age out. An EMPTY
 * pool has no oldest usage, so the answer degenerates to `now + window` — and
 * the reset time then advances at exactly the speed of the clock. That is
 * invisible while a tab is open and the samples are ~90 s apart, and fatal when
 * they are not: the sampler's own interval is fifteen minutes, three times the
 * jitter tolerance, so one idle hour on an empty pool minted five brand-new
 * "windows", each holding one sample and 0%. They landed in the ledger as five
 * columns of zero length, and dragged the observed cadence down to `0–2 days`.
 *
 * The two cases separate cleanly on WHAT THE ADVANCE EXCEEDS THE CLOCK BY. A
 * real reset moves the reset time on by about a whole window in the seconds
 * between two polls; creep moves it by exactly the time that passed. So the test
 * is `advance - elapsed`, not `advance`, and it is only allowed to conclude
 * "same window" while the advance is small against the window — otherwise a
 * sampler that was down for one window's worth of time would find `advance ≈
 * elapsed` across a rollover it genuinely missed and swallow it.
 */
function isCreep(
  instance: QuotaWindowInstance,
  sample: QuotaSample,
  windowMinutes: number,
  toleranceMs: number,
): boolean {
  const elapsed = sample.atMs - instance.lastSeenMs
  // Backfill walks files rather than the clock, so an older sample can arrive
  // late. Creep is a forward-in-time argument and has nothing to say about one.
  if (elapsed < 0) return false
  const advance = sample.resetsAtMs - instance.resetsAtMs
  if (advance < 0) return false
  const windowMs = windowMinutes * 60_000
  if (windowMs > 0 && advance >= windowMs / 2) return false
  return Math.abs(advance - elapsed) <= toleranceMs
}

/** `resetsAt - windowMinutes`, or undefined when the provider reports no duration. */
export function windowStartMs(resetsAtMs: number, windowMinutes: number): number | undefined {
  return windowMinutes > 0 ? resetsAtMs - windowMinutes * 60_000 : undefined
}

/**
 * How much of a window may run unwatched before the row stops being trustworthy.
 *
 * `partial` is a claim with a consequence — the chart hatches the column and the
 * tooltip says the peak may understate what was really spent — so the threshold
 * has to be the point where that is actually true, and it scales with the pool.
 *
 * One sampling interval, the old rule, is not that point. Fifteen minutes missed
 * from a SEVEN-DAY window is a tenth of a percent of it, and a Grok window first
 * seen 1 h 47 m in at 2% spent was flagged "joined mid-window" on the strength of
 * it. Nothing was missed; the row said otherwise anyway. Five percent of the
 * window — eight hours of a week — is a span in which real spending could
 * plausibly have gone unrecorded, and it still flags the cases that matter: a
 * Claude week first seen three days in, a Codex pool first seen after sixteen.
 *
 * The sampling interval remains the floor, because a gap smaller than one poll
 * cannot be evidence of anything, and it is the only bound available for a
 * provider that reports no window length.
 */
export const PARTIAL_MISSED_FRACTION = 0.05

/**
 * Was a MEANINGFUL part of this window already over when we first saw it?
 *
 * NOT `firstPercent > 0`. A window legitimately opens above zero when work is in
 * flight across the boundary — the rollover measured above opened at 1% on its
 * very first reading, with nothing missed. What makes a row partial is arriving
 * LATE, so the test is against the clock, not the percentage.
 */
export function isPartial(
  firstSeenMs: number,
  startedAtMs: number | undefined,
  samplingIntervalMs: number,
  windowMinutes = 0,
): boolean {
  if (startedAtMs === undefined) return false
  const windowMs = windowMinutes > 0 ? windowMinutes * 60_000 : 0
  const threshold = Math.max(samplingIntervalMs, windowMs * PARTIAL_MISSED_FRACTION)
  return firstSeenMs - startedAtMs > threshold
}

function appendTrail(
  trail: [number, number][],
  anchorMs: number,
  sample: QuotaSample,
): [number, number][] {
  const minutes = Math.max(0, Math.round((sample.atMs - anchorMs) / 60_000))
  const last = trail[trail.length - 1]
  // A repeated reading adds nothing: the daemon memoises for 120 s, so a faster
  // poll returns the identical payload. Move the point rather than growing a run
  // of duplicates, so the trail records changes and not poll cadence.
  //
  // Rebuilt rather than written through: `foldSample` reads as a pure producer of
  // a new instance, and an in-place `last[0] = …` here would reach back into the
  // caller's array and quietly mutate the instance it was handed.
  if (last && last[1] === sample.usedPercent) {
    return [...trail.slice(0, -1), [minutes, last[1]]]
  }
  const next: [number, number][] = [...trail, [minutes, sample.usedPercent]]
  if (next.length <= TRAIL_MAX_POINTS) return next
  // Halve by dropping every other interior point. The first and last points are
  // the window's open and its peak-bearing tail, so neither may be thinned away.
  const kept: [number, number][] = [next[0] as [number, number]]
  for (let i = 1; i < next.length - 1; i += 2) kept.push(next[i] as [number, number])
  kept.push(next[next.length - 1] as [number, number])
  return kept
}

/** Begin a new window instance from the first sample that lands in it. */
export function openInstance(sample: QuotaSample, samplingIntervalMs: number): QuotaWindowInstance {
  const startedAtMs = windowStartMs(sample.resetsAtMs, sample.windowMinutes)
  const anchorMs = startedAtMs ?? sample.atMs
  return {
    accountKey: sample.accountKey,
    agent: sample.agent,
    windowKey: sample.windowKey,
    label: sample.label,
    scopeModel: sample.scopeModel,
    plan: sample.plan,
    resetsAtMs: sample.resetsAtMs,
    startedAtMs,
    windowMinutes: sample.windowMinutes,
    firstSeenMs: sample.atMs,
    lastSeenMs: sample.atMs,
    firstPercent: sample.usedPercent,
    peakPercent: sample.usedPercent,
    lastPercent: sample.usedPercent,
    sampleCount: 1,
    partial: isPartial(sample.atMs, startedAtMs, samplingIntervalMs, sample.windowMinutes),
    source: sample.source,
    trail: appendTrail([], anchorMs, sample),
  }
}

/**
 * Fold one more sample into an instance it belongs to.
 *
 * `resetsAt` is rewritten to the newest reading so the row tracks the provider's
 * current answer rather than pinning whichever jittered value happened to arrive
 * first. Peak only ever climbs.
 *
 * A backfilled instance that live sampling later catches up with is promoted to
 * `live`: the live reading is the better-attested one, and a row that is half
 * recovered and half observed should not claim to be pure recovery.
 */
export function foldSample(
  instance: QuotaWindowInstance,
  sample: QuotaSample,
  samplingIntervalMs: number,
): QuotaWindowInstance {
  // Out-of-order arrival: the backfill importer walks files, not the clock, so an
  // older sample can land after a newer one. It may raise the peak and extend the
  // window backwards, but it must not rewrite "latest" state.
  const isNewer = sample.atMs >= instance.lastSeenMs
  const anchorMs = instance.startedAtMs ?? instance.firstSeenMs
  const startedAtMs = instance.startedAtMs ?? windowStartMs(sample.resetsAtMs, sample.windowMinutes)
  const firstSeenMs = Math.min(instance.firstSeenMs, sample.atMs)
  // A provider that reported no duration may start reporting one later.
  const windowMinutes = sample.windowMinutes || instance.windowMinutes
  return {
    ...instance,
    label: sample.label || instance.label,
    scopeModel: sample.scopeModel ?? instance.scopeModel,
    plan: sample.plan ?? instance.plan,
    resetsAtMs: isNewer ? sample.resetsAtMs : instance.resetsAtMs,
    windowMinutes,
    startedAtMs,
    firstSeenMs,
    lastSeenMs: Math.max(instance.lastSeenMs, sample.atMs),
    firstPercent: sample.atMs < instance.firstSeenMs ? sample.usedPercent : instance.firstPercent,
    peakPercent: Math.max(instance.peakPercent, sample.usedPercent),
    lastPercent: isNewer ? sample.usedPercent : instance.lastPercent,
    sampleCount: instance.sampleCount + 1,
    // RECOMPUTED, not carried. `firstSeenMs` can move backwards — an earlier
    // sample arriving late proves the window was watched sooner than we thought —
    // and a row that keeps its old `partial` then goes on claiming "start not
    // observed" about a start we can now show we observed.
    partial: isPartial(firstSeenMs, startedAtMs, samplingIntervalMs, windowMinutes),
    source: instance.source === 'backfill' && sample.source === 'live' ? 'live' : instance.source,
    trail: isNewer ? appendTrail(instance.trail, anchorMs, sample) : instance.trail,
  }
}

/**
 * Fold a whole run of samples for ONE (accountKey, windowKey) into the window
 * instances they describe. Samples are sorted by observation time first, so an
 * unordered backfill still produces windows in the order they really happened.
 */
export function foldSamples(
  samples: QuotaSample[],
  samplingIntervalMs: number,
  seed?: QuotaWindowInstance,
): QuotaWindowInstance[] {
  const ordered = [...samples].sort((a, b) => a.atMs - b.atMs)
  const out: QuotaWindowInstance[] = []
  let current = seed
  for (const sample of ordered) {
    if (current && isSameInstance(current, sample)) {
      current = foldSample(current, sample, samplingIntervalMs)
      continue
    }
    if (current) out.push(current)
    current = openInstance(sample, samplingIntervalMs)
  }
  if (current) out.push(current)
  return out
}
