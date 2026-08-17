import { bucketCostUsd } from '@podium/client-core/viewmodels'
import type { IssueWire, UsageBucketWire } from '@podium/model/browser'
import { type JSX, useMemo } from 'react'
import { useUsageFeed } from '@/features/usage/useUsageFeed'
import { StatusMetric, type StatusMetricBucket } from './StatusMetric'
import { money, shareShipRate, shareTokenBurn } from './status-share'
import { useReplicaIssues } from './store'
import type { Trpc } from './trpc'

const HOUR_MS = 60 * 60 * 1_000
const BURN_HOURS = 12
/** Ships are counted per DAY, so the window IS the day: the headline number is
 *  the trailing-24h count itself, not a 12-hour count multiplied out. */
const SHIP_HOURS = 24

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
 * A ship is one issue closed as DONE that had a branch, anchored at its close
 * time. Cancelled, duplicate and superseded closes are not ships, and neither is
 * an issue that never cut a branch — there was no work to land.
 *
 * It used to require `gitState.merged`, a strictly better proof that turned out
 * to be unavailable in practice: `gitState` is probed live and kept in an
 * in-memory server map that is emptied by every restart (`service/core.ts`:
 * "EPHEMERAL … lost on restart by design"), and on a host that redeploys on each
 * landing almost nothing carries the verdict. Measured on 2026-08-16: 18 issues
 * closed done on a branch in the trailing 24h, exactly ONE of them still carrying
 * a merge verdict — an 18-ship day rendered as "1". A slightly weaker proof that
 * is actually present beats a perfect one that is usually absent. The persisted
 * landing stamp (`landed_at`, POD-1085) is the proof worth upgrading to once it
 * reaches the wire and every landing path stamps it.
 *
 * Deleted issues are excluded: soft-deleted rows keep being published.
 */
export function shipHistory(issues: readonly IssueWire[], nowMs: number): StatusMetricBucket[] {
  const ships = new Map<number, number>()
  for (const issue of issues) {
    if (issue.deletedAt || issue.closedReason !== 'done' || !issue.branch || !issue.closedAt)
      continue
    const closedMs = Date.parse(issue.closedAt)
    if (!Number.isFinite(closedMs)) continue
    const startMs = Math.floor(closedMs / HOUR_MS) * HOUR_MS
    ships.set(startMs, (ships.get(startMs) ?? 0) + 1)
  }
  return hourStarts(nowMs, SHIP_HOURS).map((startMs) => ({
    startMs,
    value: ships.get(startMs) ?? 0,
  }))
}

export function StatusPerformanceStats({ trpc }: { trpc: Trpc }): JSX.Element {
  const feed = useUsageFeed(trpc)
  const issues = useReplicaIssues()
  const nowMs = Date.now()
  // Both histories are O(all issues / all usage buckets) and the strip rerenders
  // on every store tick, so they are pinned to the only two things that can move
  // them: the source rows, and the hour the buckets are cut on.
  const hourKey = Math.floor(nowMs / HOUR_MS)
  const burnBuckets = useMemo(
    () => costHistory(feed.buckets ?? [], hourKey * HOUR_MS),
    [feed.buckets, hourKey],
  )
  const shipBuckets = useMemo(() => shipHistory(issues, hourKey * HOUR_MS), [issues, hourKey])
  const burnPerHour = burnBuckets.reduce((sum, bucket) => sum + bucket.value, 0) / BURN_HOURS
  const shipped = shipBuckets.reduce((sum, bucket) => sum + bucket.value, 0)
  const shipPeak = Math.max(0, ...shipBuckets.map((bucket) => bucket.value))
  const shipNoun = shipped === 1 ? 'ship' : 'ships'
  const burnValue = feed.buckets === null ? '—/h' : `${money(burnPerHour)}/h`
  const burnShare = feed.buckets === null ? undefined : shareTokenBurn(burnPerHour)

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
        bucketMs={HOUR_MS}
        shareText={burnShare}
      />
      <span className="status-strip-seam" aria-hidden="true" />
      <StatusMetric
        testId="ship-rate-history"
        tone="ship"
        current={
          <span className="status-strip-metric-value" data-testid="status-strip-ship">
            {shipped} {shipNoun}/day
          </span>
        }
        buckets={shipBuckets}
        title="Ship rate"
        summary={`${shipped} ${shipped === 1 ? 'issue' : 'issues'} shipped over the last 24 hours.`}
        aside={`peak ${shipPeak}/h`}
        reading={(value) => ({
          value: String(value),
          label: value === 1 ? 'issue shipped' : 'issues shipped',
        })}
        foot="Last 24 hours · issues closed as done on a branch"
        bucketMs={HOUR_MS}
        shareText={shareShipRate(shipped)}
      />
    </>
  )
}
