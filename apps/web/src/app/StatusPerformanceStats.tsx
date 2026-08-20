import { bucketCostUsd } from '@podium/client-core/viewmodels'
import type { UsageBucketWire } from '@podium/model/browser'
import { type JSX, useMemo } from 'react'
import { useUsageFeed } from '@/features/usage/useUsageFeed'
import { StatusMetric, type StatusMetricBucket } from './StatusMetric'
import { money, shareTokenBurn } from './status-share'
import type { Trpc } from './trpc'

const HOUR_MS = 60 * 60 * 1_000
const MIN_RATE_WINDOW_MS = 60 * 1_000
const BURN_HOURS = 12

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

/**
 * Turn the cost observed so far this hour into an hourly pace. Usage is already
 * refreshed every 90 seconds, so this stays recent without adding another poll.
 * The one-minute floor avoids a wild extrapolation in the first seconds of an
 * hour while keeping the window much shorter than the old 12-hour average.
 */
export function currentBurnRate(buckets: readonly UsageBucketWire[], sampledAtMs: number): number {
  const hourStart = Math.floor(sampledAtMs / HOUR_MS) * HOUR_MS
  let cost = 0
  for (const bucket of buckets) {
    if (bucket.model.startsWith('<')) continue
    if (Math.floor(Date.parse(bucket.hour) / HOUR_MS) * HOUR_MS === hourStart) {
      cost += bucketCostUsd(bucket)
    }
  }
  const observedMs = Math.min(HOUR_MS, Math.max(MIN_RATE_WINDOW_MS, sampledAtMs - hourStart))
  return cost / (observedMs / HOUR_MS)
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
  const burnPerHour = currentBurnRate(feed.buckets ?? [], feed.fetchedAt ?? nowMs)
  const burnValue = feed.buckets === null ? '—/h' : `${money(burnPerHour)}/h`
  const burnShare = feed.buckets === null ? undefined : shareTokenBurn(burnPerHour)

  return (
    <StatusMetric
      testId="token-burn-history"
      tone="burn"
      current={
        <span className="status-strip-metric-value" data-testid="status-strip-burn">
          {burnValue} burn
        </span>
      }
      buckets={burnBuckets}
      title="Token burn"
      summary={`API-equivalent token cost over the last 12 hours. Current-hour pace ${burnValue}.`}
      aside={`now ${burnValue}`}
      reading={(value) => ({ value: money(value), label: 'API-equivalent cost' })}
      foot="Last 12 hours · hourly API list-price estimate"
      bucketMs={HOUR_MS}
      shareText={burnShare}
    />
  )
}
