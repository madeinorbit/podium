// workspace-scoped (POD-6959)
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
  type UserId,
} from '@podium/model'
import { asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import type { quotaWindows } from '../migrations/schema'
import { dialectPrepared } from './executor/dialect-prepared'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import { inWorkspace, param, prepared, WORKSPACE } from './executor/sync-drizzle'

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

// Every query this repository runs, prepared once per store [POD-6147], each
// held to the repository's workspace (POD-6959 design 2.4): the ledger is one
// workspace's, so its listings, its count and its prune never reach another's.

const seriesIs = (t: StoreTables) =>
  inWorkspace(
    t.quotaWindows,
    eq(t.quotaWindows.accountKey, param(t.quotaWindows.accountKey, 'accountKey')),
    eq(t.quotaWindows.windowKey, param(t.quotaWindows.windowKey, 'windowKey')),
  )

const bucketIs = (t: StoreTables) =>
  inWorkspace(
    t.quotaWindows,
    eq(t.quotaWindows.accountKey, param(t.quotaWindows.accountKey, 'accountKey')),
    eq(t.quotaWindows.windowKey, param(t.quotaWindows.windowKey, 'windowKey')),
    eq(t.quotaWindows.resetsAtBucket, param(t.quotaWindows.resetsAtBucket, 'bucket')),
  )

const newestWindowOfSeries = prepared((db, t) =>
  db
    .select()
    .from(t.quotaWindows)
    .where(seriesIs(t))
    .orderBy(desc(t.quotaWindows.resetsAtMs))
    .limit(1)
    .prepare(),
)

const windowOfBucket = prepared((db, t) =>
  db.select().from(t.quotaWindows).where(bucketIs(t)).prepare(),
)

const windowPlaceholders = {
  label: sql.placeholder('label'),
  scopeModel: sql.placeholder('scopeModel'),
  plan: sql.placeholder('plan'),
  resetsAtMs: sql.placeholder('resetsAtMs'),
  startedAtMs: sql.placeholder('startedAtMs'),
  windowMinutes: sql.placeholder('windowMinutes'),
  firstSeenMs: sql.placeholder('firstSeenMs'),
  lastSeenMs: sql.placeholder('lastSeenMs'),
  firstPercent: sql.placeholder('firstPercent'),
  peakPercent: sql.placeholder('peakPercent'),
  lastPercent: sql.placeholder('lastPercent'),
  sampleCount: sql.placeholder('sampleCount'),
  partial: sql.placeholder('partial'),
  source: sql.placeholder('source'),
  trailJson: sql.placeholder('trailJson'),
}

// The three `MAX`/`+ 1` expressions stay as `sql` FRAGMENTS inside the
// builder query (spec §6 rule 1): they read the CURRENT row beside
// `excluded`, which the builder has no expression for. The conflict target
// is the composite primary key, unchanged, and this statement was already an
// `ON CONFLICT` rather than an `OR REPLACE`.
//
// TWO FORMS [POD-6995, POD-6958 design 2.1 step 4]: SQLite's scalar `MAX(a, b)`
// takes two arguments; Postgres's `max` is an aggregate only, and its scalar
// maximum is `GREATEST(a, b)`. Everything else is the same source. Neither
// column is nullable, so the two agree on every value (they differ only on NULL:
// SQLite's `MAX` yields NULL, Postgres's `GREATEST` ignores it).
const insertWindowPlaceholders = {
  workspaceId: WORKSPACE,
  accountKey: sql.placeholder('accountKey'),
  agent: sql.placeholder('agent'),
  windowKey: sql.placeholder('windowKey'),
  resetsAtBucket: sql.placeholder('bucket'),
  ownerUserId: sql.placeholder('owner'),
  ...windowPlaceholders,
}

const insertWindowTarget = (t: StoreTables) => [
  t.quotaWindows.workspaceId,
  t.quotaWindows.accountKey,
  t.quotaWindows.windowKey,
  t.quotaWindows.resetsAtBucket,
]

const insertWindow = dialectPrepared<InsertWindowValues, void>()({
  sqlite: (db, t) =>
    db
      .insert(t.quotaWindows)
      .values(insertWindowPlaceholders)
      .onConflictDoUpdate({
        target: insertWindowTarget(t),
        set: {
          peakPercent: sql`MAX(${t.quotaWindows.peakPercent}, excluded.peak_percent)`,
          lastSeenMs: sql`MAX(${t.quotaWindows.lastSeenMs}, excluded.last_seen_ms)`,
          sampleCount: sql`${t.quotaWindows.sampleCount} + 1`,
        },
      })
      .prepare(),
  pg: (db, t) =>
    db
      .insert(t.quotaWindows)
      .values(insertWindowPlaceholders)
      .onConflictDoUpdate({
        target: insertWindowTarget(t),
        set: {
          peakPercent: sql`GREATEST(${t.quotaWindows.peakPercent}, excluded.peak_percent)`,
          lastSeenMs: sql`GREATEST(${t.quotaWindows.lastSeenMs}, excluded.last_seen_ms)`,
          sampleCount: sql`${t.quotaWindows.sampleCount} + 1`,
        },
      })
      .prepare(),
})

const updateWindow = prepared((db, t) =>
  db.update(t.quotaWindows).set(windowPlaceholders).where(bucketIs(t)).prepare(),
)

const windowsSince = prepared((db, t) =>
  db
    .select()
    .from(t.quotaWindows)
    .where(
      inWorkspace(
        t.quotaWindows,
        gte(t.quotaWindows.resetsAtMs, param(t.quotaWindows.resetsAtMs, 'sinceMs')),
      ),
    )
    .orderBy(
      asc(t.quotaWindows.accountKey),
      asc(t.quotaWindows.windowKey),
      asc(t.quotaWindows.resetsAtMs),
    )
    .prepare(),
)

/** One owner's windows that reset at or after `sinceMs`, in the served order,
 *  read along `idx_quota_windows_owner` (POD-6300). */
const ownerWindowsSince = prepared((db, t) =>
  db
    .select()
    .from(t.quotaWindows)
    .where(
      inWorkspace(
        t.quotaWindows,
        eq(t.quotaWindows.ownerUserId, param(t.quotaWindows.ownerUserId, 'owner')),
        gte(t.quotaWindows.resetsAtMs, param(t.quotaWindows.resetsAtMs, 'sinceMs')),
      ),
    )
    .orderBy(
      asc(t.quotaWindows.accountKey),
      asc(t.quotaWindows.windowKey),
      asc(t.quotaWindows.resetsAtMs),
    )
    .prepare(),
)

const trailOfBucket = prepared((db, t) =>
  db
    .select({ trailJson: t.quotaWindows.trailJson })
    .from(t.quotaWindows)
    .where(bucketIs(t))
    .prepare(),
)

const pruneWindows = prepared((db, t) =>
  db
    .delete(t.quotaWindows)
    .where(
      inWorkspace(
        t.quotaWindows,
        lt(t.quotaWindows.resetsAtMs, param(t.quotaWindows.resetsAtMs, 'cutoffMs')),
      ),
    )
    .prepare(),
)

const windowCount = prepared((db, t) =>
  db
    .select({ n: sql<number>`COUNT(*)` })
    .from(t.quotaWindows)
    .where(inWorkspace(t.quotaWindows))
    .prepare(),
)

/** The rewritable columns of one window instance, as placeholder values. */
interface WindowValues {
  readonly label: string
  readonly scopeModel: string | null
  readonly plan: string | null
  readonly resetsAtMs: number
  readonly startedAtMs: number | null
  readonly windowMinutes: number
  readonly firstSeenMs: number
  readonly lastSeenMs: number
  readonly firstPercent: number
  readonly peakPercent: number
  readonly lastPercent: number
  readonly sampleCount: number
  readonly partial: boolean
  readonly source: QuotaWindowInstance['source']
  readonly trailJson: string
}

/** The values {@link insertWindow} runs with: a window's key, bucket and owner, and its columns. */
interface InsertWindowValues extends WindowValues {
  readonly accountKey: string
  readonly agent: string
  readonly windowKey: string
  readonly bucket: number
  readonly owner: UserId | null
}

function windowValues(instance: QuotaWindowInstance): WindowValues {
  return {
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
  }
}

export class QuotaHistoryRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  /** One workspace's queries (POD-6959 design 2.4): every statement binds its workspace. */
  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  /**
   * Fold one sample into the ledger. Returns whether it opened a new window —
   * the sampler logs those, because a reset is the one event in this feature
   * that is worth a line in the log.
   */
  /**
   * `ownerUserId` is the custodian of the machine the sample came from (POD-6300).
   * It is written only when the sample OPENS a row: a window stays with whoever
   * owned it when it was first seen. Null (no custodian) leaves the row
   * answering to nobody.
   */
  async record(
    sample: QuotaSample,
    samplingIntervalMs: number,
    ownerUserId: UserId | null = null,
  ): Promise<{ openedWindow: boolean }> {
    return await this.createOrJoinTransaction(async () => {
      // The candidate is the newest window we hold for this series. A sample
      // older than it (backfill walking files out of order) is matched against it
      // anyway: `isSameInstance` compares reset times, not arrival order.
      const candidate = await newestWindowOfSeries(this.db).get({
        accountKey: sample.accountKey,
        windowKey: sample.windowKey,
      })

      if (candidate) {
        const instance = toInstance(candidate)
        if (isSameInstance(instance, sample)) {
          await this.update(
            candidate.resetsAtBucket,
            foldSample(instance, sample, samplingIntervalMs),
          )
          return { openedWindow: false }
        }
        // An older window arriving after a newer one — a backfill reaching further
        // back than the rows already stored. It is a separate instance, and its
        // own bucket keeps it separate.
        if (sample.resetsAtMs < instance.resetsAtMs) {
          const older = await this.findByBucket(sample)
          if (older) {
            const merged = foldSample(toInstance(older), sample, samplingIntervalMs)
            await this.update(older.resetsAtBucket, merged)
            return { openedWindow: false }
          }
        }
      }
      await this.insert(openInstance(sample, samplingIntervalMs), ownerUserId)
      return { openedWindow: true }
    })
  }

  private async findByBucket(sample: QuotaSample): Promise<Row | undefined> {
    return await windowOfBucket(this.db).get({
      accountKey: sample.accountKey,
      windowKey: sample.windowKey,
      bucket: bucketOf(sample.resetsAtMs),
    })
  }

  private async insert(instance: QuotaWindowInstance, ownerUserId: UserId | null): Promise<void> {
    // The upsert's conflict arm is explained at `insertWindow`.
    await insertWindow(this.db).run({
      accountKey: instance.accountKey,
      agent: instance.agent,
      windowKey: instance.windowKey,
      bucket: bucketOf(instance.resetsAtMs),
      owner: ownerUserId,
      ...windowValues(instance),
    })
  }

  /** Rewrites everything except the bucket, which is identity and never moves. */
  private async update(bucket: number, instance: QuotaWindowInstance): Promise<void> {
    await updateWindow(this.db).run({
      accountKey: instance.accountKey,
      windowKey: instance.windowKey,
      bucket,
      ...windowValues(instance),
    })
  }

  /** Every window of this workspace that reset at or after `sinceMs`, oldest
   *  first, WHOEVER owns it. For the ledger's own tests and maintenance; never
   *  served to a member. */
  async list(sinceMs: number, nowMs: number): Promise<QuotaWindowHistoryWire[]> {
    const rows = await windowsSince(this.db).all({ sinceMs })
    return rows.map((r) => toWire(r, nowMs))
  }

  /** One member's windows that reset at or after `sinceMs` (POD-6300). */
  async listFor(
    ownerUserId: UserId,
    sinceMs: number,
    nowMs: number,
  ): Promise<QuotaWindowHistoryWire[]> {
    const rows = await ownerWindowsSince(this.db).all({ owner: ownerUserId, sinceMs })
    return rows.map((r) => toWire(r, nowMs))
  }

  /** The stored burn curve for one window instance. Empty when unknown. */
  async trail(
    accountKey: string,
    windowKey: string,
    resetsAtMs: number,
  ): Promise<[number, number][]> {
    const row = await trailOfBucket(this.db).get({
      accountKey,
      windowKey,
      bucket: bucketOf(resetsAtMs),
    })
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
  async prune(cutoffMs: number): Promise<number> {
    const res = await pruneWindows(this.db).run({ cutoffMs })
    return Number(res.changes)
  }

  async countAll(): Promise<number> {
    const row = await windowCount(this.db).get()
    return row?.n ?? 0
  }
}

function bucketOf(resetsAtMs: number): number {
  return Math.floor(resetsAtMs / RESET_BUCKET_MS)
}
