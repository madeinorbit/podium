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
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { quotaWindows } from '../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'

/** Quantisation behind the uniqueness constraint only — never an identity test. */
const RESET_BUCKET_MS = 60_000

/**
 * The stored row, as drizzle's own execution path maps it back — TypeScript
 * names off the schema rather than the physical `snake_case` ones.
 *
 * `partial` arrives as a BOOLEAN rather than 0/1, because the column is declared
 * `integer({ mode: 'boolean' })` and drizzle applies that mapping. The
 * `row.partial === 1` and `partial ? 1 : 0` conversions the raw driver needed
 * are therefore gone rather than rewritten; the stored bytes are unchanged.
 */
type Row = typeof quotaWindows.$inferSelect

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
    accountKey: row.accountKey,
    agent: row.agent as AgentKind,
    windowKey: row.windowKey,
    label: row.label,
    scopeModel: row.scopeModel ?? undefined,
    plan: row.plan ?? undefined,
    resetsAtMs: row.resetsAtMs,
    startedAtMs: row.startedAtMs ?? undefined,
    windowMinutes: row.windowMinutes,
    firstSeenMs: row.firstSeenMs,
    lastSeenMs: row.lastSeenMs,
    firstPercent: row.firstPercent,
    peakPercent: row.peakPercent,
    lastPercent: row.lastPercent,
    sampleCount: row.sampleCount,
    partial: row.partial,
    source: row.source === 'backfill' ? 'backfill' : 'live',
    trail: parseTrail(row.trailJson),
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

function toWire(row: Row, nowMs: number): QuotaWindowHistoryWire {
  return {
    accountKey: row.accountKey,
    agent: row.agent as AgentKind,
    windowKey: row.windowKey,
    label: row.label,
    ...(row.scopeModel ? { scopeModel: row.scopeModel } : {}),
    ...(row.plan ? { plan: row.plan } : {}),
    resetsAt: iso(row.resetsAtMs),
    ...(row.startedAtMs !== null ? { startedAt: iso(row.startedAtMs) } : {}),
    windowMinutes: row.windowMinutes,
    firstSeenAt: iso(row.firstSeenMs),
    lastSeenAt: iso(row.lastSeenMs),
    firstPercent: row.firstPercent,
    peakPercent: row.peakPercent,
    lastPercent: row.lastPercent,
    sampleCount: row.sampleCount,
    closed: nowMs > row.resetsAtMs,
    partial: row.partial,
    source: row.source === 'backfill' ? 'backfill' : 'live',
  }
}

export class QuotaHistoryRepository {
  private readonly rootDb: SyncDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db() {
    return this.rootDb
  }

  /**
   * Fold one sample into the ledger. Returns whether it opened a new window —
   * the sampler logs those, because a reset is the one event in this feature
   * that is worth a line in the log.
   */
  record(sample: QuotaSample, samplingIntervalMs: number): { openedWindow: boolean } {
    return this.createOrJoinTransaction(() => {
      // The candidate is the newest window we hold for this series. A sample
      // older than it (backfill walking files out of order) is matched against it
      // anyway: `isSameInstance` compares reset times, not arrival order.
      const candidate = this.db
        .select()
        .from(quotaWindows)
        .where(
          and(
            eq(quotaWindows.accountKey, sample.accountKey),
            eq(quotaWindows.windowKey, sample.windowKey),
          ),
        )
        .orderBy(desc(quotaWindows.resetsAtMs))
        .limit(1)
        .get()

      if (candidate) {
        const instance = toInstance(candidate)
        if (isSameInstance(instance, sample)) {
          this.update(candidate.resetsAtBucket, foldSample(instance, sample, samplingIntervalMs))
          return { openedWindow: false }
        }
        // An older window arriving after a newer one — a backfill reaching further
        // back than the rows already stored. It is a separate instance, and its
        // own bucket keeps it separate.
        if (sample.resetsAtMs < instance.resetsAtMs) {
          const older = this.findByBucket(sample)
          if (older) {
            const merged = foldSample(toInstance(older), sample, samplingIntervalMs)
            this.update(older.resetsAtBucket, merged)
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
      .select()
      .from(quotaWindows)
      .where(
        and(
          eq(quotaWindows.accountKey, sample.accountKey),
          eq(quotaWindows.windowKey, sample.windowKey),
          eq(quotaWindows.resetsAtBucket, bucketOf(sample.resetsAtMs)),
        ),
      )
      .get()
  }

  private insert(instance: QuotaWindowInstance): void {
    // The three `MAX`/`+ 1` expressions stay as `sql` FRAGMENTS inside the
    // builder query (spec §6 rule 1): they read the CURRENT row beside
    // `excluded`, which the builder has no expression for. The conflict target
    // is the composite primary key, unchanged, and this statement was already an
    // `ON CONFLICT` rather than an `OR REPLACE`.
    this.db
      .insert(quotaWindows)
      .values({
        accountKey: instance.accountKey,
        agent: instance.agent,
        windowKey: instance.windowKey,
        resetsAtBucket: bucketOf(instance.resetsAtMs),
        label: instance.label,
        scopeModel: instance.scopeModel ?? null,
        plan: instance.plan ?? null,
        resetsAtMs: instance.resetsAtMs,
        startedAtMs: instance.startedAtMs ?? null,
        windowMinutes: instance.windowMinutes,
        firstSeenMs: instance.firstSeenMs,
        lastSeenMs: instance.lastSeenMs,
        firstPercent: instance.firstPercent,
        peakPercent: instance.peakPercent,
        lastPercent: instance.lastPercent,
        sampleCount: instance.sampleCount,
        partial: instance.partial,
        source: instance.source,
        trailJson: JSON.stringify(instance.trail),
      })
      .onConflictDoUpdate({
        target: [quotaWindows.accountKey, quotaWindows.windowKey, quotaWindows.resetsAtBucket],
        set: {
          peakPercent: sql`MAX(${quotaWindows.peakPercent}, excluded.peak_percent)`,
          lastSeenMs: sql`MAX(${quotaWindows.lastSeenMs}, excluded.last_seen_ms)`,
          sampleCount: sql`${quotaWindows.sampleCount} + 1`,
        },
      })
      .run()
  }

  /** Rewrites everything except the bucket, which is identity and never moves. */
  private update(bucket: number, instance: QuotaWindowInstance): void {
    this.db
      .update(quotaWindows)
      .set({
        label: instance.label,
        scopeModel: instance.scopeModel ?? null,
        plan: instance.plan ?? null,
        resetsAtMs: instance.resetsAtMs,
        startedAtMs: instance.startedAtMs ?? null,
        windowMinutes: instance.windowMinutes,
        firstSeenMs: instance.firstSeenMs,
        lastSeenMs: instance.lastSeenMs,
        firstPercent: instance.firstPercent,
        peakPercent: instance.peakPercent,
        lastPercent: instance.lastPercent,
        sampleCount: instance.sampleCount,
        partial: instance.partial,
        source: instance.source,
        trailJson: JSON.stringify(instance.trail),
      })
      .where(
        and(
          eq(quotaWindows.accountKey, instance.accountKey),
          eq(quotaWindows.windowKey, instance.windowKey),
          eq(quotaWindows.resetsAtBucket, bucket),
        ),
      )
      .run()
  }

  /** Every window that reset at or after `sinceMs`, oldest first. */
  list(sinceMs: number, nowMs: number): QuotaWindowHistoryWire[] {
    const rows = this.db
      .select()
      .from(quotaWindows)
      .where(gte(quotaWindows.resetsAtMs, sinceMs))
      .orderBy(
        asc(quotaWindows.accountKey),
        asc(quotaWindows.windowKey),
        asc(quotaWindows.resetsAtMs),
      )
      .all()
    return rows.map((r) => toWire(r, nowMs))
  }

  /** The stored burn curve for one window instance. Empty when unknown. */
  trail(accountKey: string, windowKey: string, resetsAtMs: number): [number, number][] {
    const row = this.db
      .select({ trailJson: quotaWindows.trailJson })
      .from(quotaWindows)
      .where(
        and(
          eq(quotaWindows.accountKey, accountKey),
          eq(quotaWindows.windowKey, windowKey),
          eq(quotaWindows.resetsAtBucket, bucketOf(resetsAtMs)),
        ),
      )
      .get()
    return row ? parseTrail(row.trailJson) : []
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
    const res = this.db.delete(quotaWindows).where(lt(quotaWindows.resetsAtMs, cutoffMs)).run()
    return Number(res.changes)
  }

  countAll(): number {
    const row = this.db.select({ n: sql<number>`COUNT(*)` }).from(quotaWindows).get()
    return row?.n ?? 0
  }
}

function bucketOf(resetsAtMs: number): number {
  return Math.floor(resetsAtMs / RESET_BUCKET_MS)
}
