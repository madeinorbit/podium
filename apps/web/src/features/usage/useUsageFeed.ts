import type { MobxPool } from '@podium/client-graph'
import type { UsageBucketWire } from '@podium/model/browser'
import { useRef } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

/**
 * The usage feed (the usage sheet and the status strip's burn rate): this
 * account's token usage, PUSHED by the server on `account.usage` and held in
 * the LiveStore (POD-5798). There is no poll: while a reader is mounted the
 * server's live pass re-reads usage, and a reconnect resubscribes and gets the
 * newest value. With no reader mounted, nothing is harvested.
 *
 * Cache-first still holds: when the last reader leaves, the LiveStore keeps
 * the last reading (as "last read"), so reopening the sheet paints numbers on
 * its first frame while the fresh one arrives. Nothing is saved: a new run
 * starts unknown.
 */

const SCAN_HISTORY_MS = 15 * 60_000

export interface UsageScan {
  sampledAt: number
  buckets: UsageBucketWire[]
}

interface UsageReadingView {
  readonly buckets: UsageBucketWire[] | null
  readonly sampledAt: number
  readonly at: number | null
  readonly known: boolean
  readonly answered: boolean
}

const COLD: UsageReadingView = {
  buckets: null,
  sampledAt: Number.NaN,
  at: null,
  known: false,
  answered: false,
}

/**
 * The LiveStore's usage reading. Reading it from a mounted projection is what
 * holds `account.usage`: the server harvests only while a usage reader is up.
 */
function readUsage(pool: MobxPool): UsageReadingView {
  const reading = pool.live?.usage()
  if (!reading) return COLD
  const value = reading.known ? reading.value : reading.last
  const usage = value
  return {
    buckets: usage ? usage.buckets : null,
    sampledAt: Date.parse(usage?.sampledAt ?? ''),
    at: reading.known ? reading.at : value ? reading.since : null,
    known: reading.known,
    answered: value !== undefined,
  }
}

// The rolling burn rate needs the last 15 minutes of distinct daemon scans.
// Their lifetime is the browser tab, as before; only a strictly newer scan
// advances it.
let scanHistory: UsageScan[] = []

function recordScan(sampledAt: number, buckets: UsageBucketWire[]): void {
  const latest = scanHistory.at(-1)
  if (!Number.isFinite(sampledAt) || sampledAt <= (latest?.sampledAt ?? -Infinity)) return
  scanHistory = [...scanHistory, { sampledAt, buckets }].filter(
    (scan) => scan.sampledAt >= sampledAt - SCAN_HISTORY_MS,
  )
}

/** Tests only — the scan history is deliberately process-wide otherwise. */
export function resetUsageCache(): void {
  scanHistory = []
}

export interface UsageFeed {
  /** Null only while this run has never had an answer: the one cold state. */
  buckets: UsageBucketWire[] | null
  /** When `buckets` was received, for the staleness stamp. */
  fetchedAt: number | null
  /** Distinct daemon scans from the last 15 minutes, oldest first. */
  scans: readonly UsageScan[]
  /** No answer yet in this run (the first reading is on its way). */
  waiting: boolean
  /**
   * What is on screen is not current: the connection was lost (the last value
   * is kept), or the server answered without usage (no machine may answer for
   * this account's transcripts, or the scan failed).
   */
  failed: boolean
}

export function useUsageFeed(): UsageFeed {
  const reading = useWorklistPoolProjection(readUsage, COLD)
  // Idempotent: only a strictly newer scan is recorded, so a repeated render
  // (StrictMode, an unrelated rerender) adds nothing.
  if (reading.buckets) recordScan(reading.sampledAt, reading.buckets)
  return {
    buckets: reading.buckets,
    fetchedAt: reading.at,
    scans: scanHistory,
    waiting: !reading.answered,
    failed: reading.answered && (!reading.known || reading.buckets === null),
  }
}

/**
 * True for a sheet that opened with nothing and then received its first answer —
 * the only moment the arrival animation is licensed. A sheet that opened from
 * cache already had its numbers, and animating them in would be choreography
 * over content the operator can already read.
 */
export function useArrived(hasData: boolean): boolean {
  const startedCold = useRef(!hasData)
  return startedCold.current && hasData
}

/** `14:32` — the local clock time a reading was taken. */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
