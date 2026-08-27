import { bucketCostUsd } from '@podium/client-core/viewmodels'
import type { UsageBucketWire } from '@podium/model/browser'
import { type JSX, useMemo } from 'react'
import { type UsageScan, useUsageFeed } from '@/features/usage/useUsageFeed'
import { StatusMetric, type StatusMetricBucket } from './StatusMetric'
import { money, shareTokenBurn } from './status-share'
import type { Trpc } from './trpc'

const HOUR_MS = 60 * 60 * 1_000
const BURN_HOURS = 12
export const BURN_RATE_WINDOW_MS = 15 * 60 * 1_000
export const MIN_BURN_RATE_WINDOW_MS = 10 * 60 * 1_000
const MIN_BURN_RATE_SCANS = 3

function hourStarts(nowMs: number, hours: number): number[] {
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS
  return Array.from({ length: hours }, (_, index) => currentHour - (hours - 1 - index) * HOUR_MS)
}

export function costHistory(
  buckets: readonly UsageBucketWire[],
  nowMs: number,
): StatusMetricBucket[] {
  const costs = new Map<number, number>()
  for (const bucket of buckets) {
    if (bucket.model.startsWith('<')) continue
    const startMs = Math.floor(Date.parse(bucket.hour) / HOUR_MS) * HOUR_MS
    costs.set(startMs, (costs.get(startMs) ?? 0) + bucketCostUsd(bucket))
  }
  return hourStarts(nowMs, BURN_HOURS).map((startMs) => ({
    startMs,
    value: costs.get(startMs) ?? 0,
  }))
}

function bucketKey(bucket: UsageBucketWire): string {
  return `${bucket.hour}|${bucket.model}`
}

function costDelta(previous: UsageScan, current: UsageScan): number {
  const priorCosts = new Map(
    previous.buckets
      .filter((bucket) => !bucket.model.startsWith('<'))
      .map((bucket) => [bucketKey(bucket), bucketCostUsd(bucket)]),
  )
  let delta = 0
  for (const bucket of current.buckets) {
    if (bucket.model.startsWith('<')) continue
    delta += Math.max(0, bucketCostUsd(bucket) - (priorCosts.get(bucketKey(bucket)) ?? 0))
  }
  return delta
}

export interface RollingBurnRate {
  perHour: number
  windowMinutes: number
}

/**
 * API-list-price pace across a real rolling window. One response can dominate
 * a two-minute scan delta, so the footer waits for at least three scans and ten
 * minutes of evidence before it publishes a rate.
 */
export function rollingBurnRate(scans: readonly UsageScan[]): RollingBurnRate | null {
  if (scans.length < MIN_BURN_RATE_SCANS) return null
  const current = scans.at(-1)
  if (!current) return null
  const eligible = scans.filter(
    (scan) => scan.sampledAt >= current.sampledAt - BURN_RATE_WINDOW_MS,
  )
  if (eligible.length < MIN_BURN_RATE_SCANS) return null
  const previous = eligible[0]
  if (!previous) return null
  const elapsedMs = current.sampledAt - previous.sampledAt
  if (elapsedMs < MIN_BURN_RATE_WINDOW_MS) return null
  return {
    perHour: costDelta(previous, current) / (elapsedMs / HOUR_MS),
    windowMinutes: Math.max(1, Math.round(elapsedMs / 60_000)),
  }
}

export function StatusPerformanceStats({ trpc }: { trpc: Trpc }): JSX.Element {
  const feed = useUsageFeed(trpc)
  const nowMs = Date.now()
  // History is O(all usage buckets) and the strip rerenders on every store tick,
  // so it is pinned to the source rows and the hour the buckets are cut on.
  const hourKey = Math.floor(nowMs / HOUR_MS)
  const burnBuckets = useMemo(
    () => costHistory(feed.buckets ?? [], hourKey * HOUR_MS),
    [feed.buckets, hourKey],
  )
  const rate = rollingBurnRate(feed.scans)
  const burnValue =
    feed.buckets === null
      ? '— token burn'
      : rate
        ? `${money(rate.perHour)}/h token burn`
        : 'measuring token burn'
  const burnShare = rate ? shareTokenBurn(rate.perHour, rate.windowMinutes) : undefined

  return (
    <StatusMetric
      testId="token-burn-history"
      tone="burn"
      current={
        <span className="status-strip-metric-value" data-testid="status-strip-burn">
          {burnValue}
        </span>
      }
      buckets={burnBuckets}
      title="API-equivalent token rate"
      summary={`API-equivalent token cost over the last 12 hours. Rolling rate ${burnValue}.`}
      aside={rate ? `${rate.windowMinutes}m average` : 'measuring'}
      reading={(value) => ({ value: money(value), label: 'API-equivalent cost' })}
      foot="Trace: last 12 hours · headline: 10–15 minute API list-price average"
      bucketMs={HOUR_MS}
      shareText={burnShare}
    />
  )
}
