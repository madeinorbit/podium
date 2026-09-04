/**
 * THE QUOTA WINDOW LEDGER — one row per run of a plan window, folded on write.
 *
 * Podium had never written a quota number to disk before this table. Everything
 * else on the quota path is a live pull-through read with a 120-second memo, so a
 * window that elapsed while nobody had a tab open left no trace at all. That is
 * what this repository exists to stop.
 *
 * WRITES ARE FOLD-THEN-UPSERT, INSIDE A TRANSACTION. Deciding whether a sample
 * continues the open window or starts a new one is a read-modify-write, and there
 * are several concurrent writers: the sampler timer, the opportunistic write on
 * `quota.summary`, the backfill importer, and every machine signed into the same
 * account reporting the same limits. The transaction is what makes them converge
 * on one row instead of racing.
 *
 * THE BUCKET IS ASSIGNED ONCE, AT INSERT. `resets_at_bucket` exists only so the
 * uniqueness constraint can be written in SQL; it is NOT the identity rule. It
 * must never be recomputed on update, because the provider's reset time jitters
 * and a jitter that straddles a bucket boundary would mint a duplicate row for a
 * window we are already tracking — the exact failure the tolerant fold prevents.
 * A measured Claude trace crosses an hour boundary (`01:00:00.039` →
 * `00:59:59.325`), so this is a real case and not a hypothetical one.
 */

import {
  type AgentKind,
  foldSample,
  isSameInstance,
  openInstance,
  type QuotaSample,
  type QuotaWindowHistoryWire,
  type QuotaWindowInstance,
} from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { transaction } from '@podium/runtime/sqlite'

/** Quantisation behind the uniqueness constraint only — never an identity test. */
const RESET_BUCKET_MS = 60_000

interface Row {
  account_key: string
  agent: string
  window_key: string
  resets_at_bucket: number
  label: string
  scope_model: string | null
  plan: string | null
  resets_at_ms: number
  started_at_ms: number | null
  window_minutes: number
  first_seen_ms: number
  last_seen_ms: number
  first_percent: number
  peak_percent: number
  last_percent: number
  sample_count: number
  partial: number
  source: string
  trail_json: string
}

function parseTrail(json: string): [number, number][] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is [number, number] =>
        Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number',
    )
  } catch {
    // A trail is decoration on top of the numbers that matter; a corrupt one
    // must not take the window's peak down with it.
    return []
  }
}

function toInstance(row: Row): QuotaWindowInstance {
  return {
    accountKey: row.account_key,
    agent: row.agent as AgentKind,
    windowKey: row.window_key,
    label: row.label,
    scopeModel: row.scope_model ?? undefined,
    plan: row.plan ?? undefined,
    resetsAtMs: row.resets_at_ms,
    startedAtMs: row.started_at_ms ?? undefined,
    windowMinutes: row.window_minutes,
    firstSeenMs: row.first_seen_ms,
    lastSeenMs: row.last_seen_ms,
    firstPercent: row.first_percent,
    peakPercent: row.peak_percent,
    lastPercent: row.last_percent,
    sampleCount: row.sample_count,
    partial: row.partial === 1,
    source: row.source === 'backfill' ? 'backfill' : 'live',
    trail: parseTrail(row.trail_json),
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

function toWire(row: Row, nowMs: number): QuotaWindowHistoryWire {
  return {
    accountKey: row.account_key,
    agent: row.agent as AgentKind,
    windowKey: row.window_key,
    label: row.label,
    ...(row.scope_model ? { scopeModel: row.scope_model } : {}),
    ...(row.plan ? { plan: row.plan } : {}),
    resetsAt: iso(row.resets_at_ms),
    ...(row.started_at_ms !== null ? { startedAt: iso(row.started_at_ms) } : {}),
    windowMinutes: row.window_minutes,
    firstSeenAt: iso(row.first_seen_ms),
    lastSeenAt: iso(row.last_seen_ms),
    firstPercent: row.first_percent,
    peakPercent: row.peak_percent,
    lastPercent: row.last_percent,
    sampleCount: row.sample_count,
    closed: nowMs > row.resets_at_ms,
    partial: row.partial === 1,
    source: row.source === 'backfill' ? 'backfill' : 'live',
  }
}

export class QuotaHistoryRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Fold one sample into the ledger. Returns whether it opened a new window —
   * the sampler logs those, because a reset is the one event in this feature
   * that is worth a line in the log.
   */
  record(sample: QuotaSample, samplingIntervalMs: number): { openedWindow: boolean } {
    return transaction(this.db, () => {
      // The candidate is the newest window we hold for this series. A sample
      // older than it (backfill walking files out of order) is matched against it
      // anyway: `isSameInstance` compares reset times, not arrival order.
      const candidate = this.db
        .prepare(
          `SELECT * FROM quota_windows
           WHERE account_key = ? AND window_key = ?
           ORDER BY resets_at_ms DESC LIMIT 1`,
        )
        .get(sample.accountKey, sample.windowKey) as Row | undefined

      if (candidate) {
        const instance = toInstance(candidate)
        if (isSameInstance(instance, sample)) {
          this.update(candidate.resets_at_bucket, foldSample(instance, sample, samplingIntervalMs))
          return { openedWindow: false }
        }
        // An older window arriving after a newer one — a backfill reaching further
        // back than the rows already stored. It is a separate instance, and its
        // own bucket keeps it separate.
        if (sample.resetsAtMs < instance.resetsAtMs) {
          const older = this.findByBucket(sample)
          if (older) {
            const merged = foldSample(toInstance(older), sample, samplingIntervalMs)
            this.update(older.resets_at_bucket, merged)
            return { openedWindow: false }
          }
        }
      }
      this.insert(openInstance(sample, samplingIntervalMs))
      return { openedWindow: true }
    })
  }

  private findByBucket(sample: QuotaSample): Row | undefined {
    return this.db
      .prepare(
        `SELECT * FROM quota_windows
         WHERE account_key = ? AND window_key = ? AND resets_at_bucket = ?`,
      )
      .get(sample.accountKey, sample.windowKey, bucketOf(sample.resetsAtMs)) as Row | undefined
  }

  private insert(instance: QuotaWindowInstance): void {
    this.db
      .prepare(
        `INSERT INTO quota_windows
           (account_key, agent, window_key, resets_at_bucket, label, scope_model, plan,
            resets_at_ms, started_at_ms, window_minutes, first_seen_ms, last_seen_ms,
            first_percent, peak_percent, last_percent, sample_count, partial, source, trail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_key, window_key, resets_at_bucket) DO UPDATE SET
           peak_percent = MAX(quota_windows.peak_percent, excluded.peak_percent),
           last_seen_ms = MAX(quota_windows.last_seen_ms, excluded.last_seen_ms),
           sample_count = quota_windows.sample_count + 1`,
      )
      .run(
        instance.accountKey,
        instance.agent,
        instance.windowKey,
        bucketOf(instance.resetsAtMs),
        instance.label,
        instance.scopeModel ?? null,
        instance.plan ?? null,
        instance.resetsAtMs,
        instance.startedAtMs ?? null,
        instance.windowMinutes,
        instance.firstSeenMs,
        instance.lastSeenMs,
        instance.firstPercent,
        instance.peakPercent,
        instance.lastPercent,
        instance.sampleCount,
        instance.partial ? 1 : 0,
        instance.source,
        JSON.stringify(instance.trail),
      )
  }

  /** Rewrites everything except the bucket, which is identity and never moves. */
  private update(bucket: number, instance: QuotaWindowInstance): void {
    this.db
      .prepare(
        `UPDATE quota_windows SET
           label = ?, scope_model = ?, plan = ?, resets_at_ms = ?, started_at_ms = ?,
           window_minutes = ?, first_seen_ms = ?, last_seen_ms = ?, first_percent = ?,
           peak_percent = ?, last_percent = ?, sample_count = ?, partial = ?, source = ?,
           trail_json = ?
         WHERE account_key = ? AND window_key = ? AND resets_at_bucket = ?`,
      )
      .run(
        instance.label,
        instance.scopeModel ?? null,
        instance.plan ?? null,
        instance.resetsAtMs,
        instance.startedAtMs ?? null,
        instance.windowMinutes,
        instance.firstSeenMs,
        instance.lastSeenMs,
        instance.firstPercent,
        instance.peakPercent,
        instance.lastPercent,
        instance.sampleCount,
        instance.partial ? 1 : 0,
        instance.source,
        JSON.stringify(instance.trail),
        instance.accountKey,
        instance.windowKey,
        bucket,
      )
  }

  /** Every window that reset at or after `sinceMs`, oldest first. */
  list(sinceMs: number, nowMs: number): QuotaWindowHistoryWire[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM quota_windows
         WHERE resets_at_ms >= ?
         ORDER BY account_key, window_key, resets_at_ms`,
      )
      .all(sinceMs) as Row[]
    return rows.map((r) => toWire(r, nowMs))
  }

  /** The stored burn curve for one window instance. Empty when unknown. */
  trail(accountKey: string, windowKey: string, resetsAtMs: number): [number, number][] {
    const row = this.db
      .prepare(
        `SELECT trail_json FROM quota_windows
         WHERE account_key = ? AND window_key = ? AND resets_at_bucket = ?`,
      )
      .get(accountKey, windowKey, bucketOf(resetsAtMs)) as { trail_json: string } | undefined
    return row ? parseTrail(row.trail_json) : []
  }

  /**
   * Drop windows that reset before `cutoffMs`.
   *
   * Pruned inline by the writer rather than by a janitor job: a new job kind
   * would force a `MAINTENANCE_PROTOCOL_VERSION` bump, because an older server
   * fails to parse a `MaintenanceCommand` naming a kind it does not know. A
   * single indexed DELETE on a table of this size does not warrant that.
   */
  prune(cutoffMs: number): number {
    const res = this.db.prepare(`DELETE FROM quota_windows WHERE resets_at_ms < ?`).run(cutoffMs)
    return Number(res.changes)
  }

  countAll(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM quota_windows`).get() as { n: number }
    return row.n
  }
}

function bucketOf(resetsAtMs: number): number {
  return Math.floor(resetsAtMs / RESET_BUCKET_MS)
}
