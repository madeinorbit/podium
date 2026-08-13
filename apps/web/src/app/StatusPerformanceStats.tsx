import { bucketCostUsd } from '@podium/client-core/viewmodels'
import type { IssueWire, UsageBucketWire } from '@podium/model/browser'
import type { JSX } from 'react'
import { useUsageFeed } from '@/features/usage/useUsageFeed'
import { StatusMetric, type StatusMetricBucket } from './StatusMetric'
import { shareShipRate, shareTokenBurn } from './status-share'
import { useReplicaIssues } from './store'
import type { Trpc } from './trpc'

const HOUR_MS = 60 * 60 * 1_000
const WINDOW_HOURS = 12

function money(value: number): string {
  const digits = value >= 10 ? 1 : value >= 0.1 ? 2 : value > 0 ? 3 : 0
  return `$${value.toFixed(digits)}`
}

function rate(value: number): string {
  if (value === 0) return '0'
  return value >= 1 ? value.toFixed(1) : value.toFixed(2)
}

function hourStarts(nowMs: number): number[] {
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS
  return Array.from(
    { length: WINDOW_HOURS },
    (_, index) => currentHour - (WINDOW_HOURS - 1 - index) * HOUR_MS,
  )
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
  return hourStarts(nowMs).map((startMs) => ({ startMs, value: costs.get(startMs) ?? 0 }))
}

/**
 * A ship is one issue whose branch Podium currently proves is landed. The
 * stable close timestamp supplies the history anchor because the git probe has
 * a landed verdict but no persisted landing event time. A PR URL alone is not
 * counted: it establishes that a PR exists, not that it merged.
 */
export function shipHistory(issues: readonly IssueWire[], nowMs: number): StatusMetricBucket[] {
  const ships = new Map<number, number>()
  for (const issue of issues) {
    if (!issue.gitState?.merged || !issue.closedAt) continue
    const closedMs = Date.parse(issue.closedAt)
    if (!Number.isFinite(closedMs)) continue
    const startMs = Math.floor(closedMs / HOUR_MS) * HOUR_MS
    ships.set(startMs, (ships.get(startMs) ?? 0) + 1)
  }
  return hourStarts(nowMs).map((startMs) => ({ startMs, value: ships.get(startMs) ?? 0 }))
}

export function StatusPerformanceStats({ trpc }: { trpc: Trpc }): JSX.Element {
  const feed = useUsageFeed(trpc)
  const issues = useReplicaIssues()
  const nowMs = Date.now()
  const burnBuckets = costHistory(feed.buckets ?? [], nowMs)
  const shipBuckets = shipHistory(issues, nowMs)
  const burnPerHour = burnBuckets.reduce((sum, bucket) => sum + bucket.value, 0) / WINDOW_HOURS
  const shipped = shipBuckets.reduce((sum, bucket) => sum + bucket.value, 0)
  const shipsPerHour = shipped / WINDOW_HOURS
  const burnValue = feed.buckets === null ? '—/h' : `${money(burnPerHour)}/h`
  const burnShare = feed.buckets === null ? undefined : shareTokenBurn(money(burnPerHour))

  return (
    <>
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
        summary={`API-equivalent token cost over the last 12 hours. Rolling average ${burnValue}.`}
        aside={`avg ${burnValue}`}
        reading={(value) => ({ value: money(value), label: 'API-equivalent cost' })}
        foot="Last 12 hours · hourly API list-price estimate"
        shareText={burnShare}
      />
      <span className="status-strip-seam" aria-hidden="true" />
      <StatusMetric
        testId="ship-rate-history"
        tone="ship"
        current={
          <span className="status-strip-metric-value" data-testid="status-strip-ship">
            {rate(shipsPerHour)} ships/h
          </span>
        }
        buckets={shipBuckets}
        title="Ship rate"
        summary={`${shipped} confirmed ${shipped === 1 ? 'merge' : 'merges'} over the last 12 hours. Rolling average ${rate(shipsPerHour)} ships per hour.`}
        aside={`${shipped} landed`}
        reading={(value) => ({
          value: String(value),
          label: value === 1 ? 'confirmed merge' : 'confirmed merges',
        })}
        foot="Last 12h · landed branches; a PR URL alone is excluded"
        shareText={shareShipRate(shipped, rate(shipsPerHour))}
      />
    </>
  )
}
