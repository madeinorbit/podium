import type { IssueId } from '@podium/model'
import { and, eq, gte, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm'
import { notificationFacts } from '../migrations/schema'
import type { QueryClient, StoreExecutor } from './executor'
import type { SyncDrizzle } from './executor/sync-drizzle'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

interface FactClaim {
  factKey: string
  target: string
  source: string | null
  issueId: IssueId | null
  createdAt: string
  expiresAt: string | null
}

/** Durable atomic claims behind the steward's notification arbiter [spec:SP-ba61]. */
export class NotificationFactsRepository {
  private readonly db: SyncDrizzle

  constructor(executor: StoreExecutor<QueryClient>) {
    // Stage A's synchronous seam, asserted HERE so a store built over a non-bun
    // handle names the repository that needed it [spec rule 27a].
    if (!executor.stageA) {
      throw new Error("NotificationFactsRepository needs the executor's Stage A drizzle instance")
    }
    this.db = executor.stageA.db
  }

  /**
   * Insert a new claim, or refresh a retired claim. The conflict guard is part of
   * the single write statement, so concurrent producers cannot both win.
   */
  claim(fact: FactClaim): boolean {
    // A WRITE THAT RETURNS ROWS, and the exact statement POD-3318 was found on:
    // drizzle emits `INSERT ... RETURNING` through the `all` decoder, so nothing
    // may read write intent off the method. `.returning()` on an insert IS the
    // declaration (spec rule 27a), and the terminal `.get()` only says how many
    // rows come back.
    const row = this.db
      .insert(notificationFacts)
      .values({
        factKey: fact.factKey,
        target: fact.target,
        source: fact.source,
        issueId: fact.issueId,
        createdAt: fact.createdAt,
        expiresAt: fact.expiresAt,
        consumedAt: null,
      })
      .onConflictDoUpdate({
        target: [notificationFacts.factKey, notificationFacts.target],
        set: {
          source: sql`excluded.source`,
          issueId: sql`excluded.issue_id`,
          createdAt: sql`excluded.created_at`,
          expiresAt: sql`excluded.expires_at`,
          consumedAt: null,
        },
        // The conflict guard is part of the single write statement, so
        // concurrent producers cannot both win.
        setWhere: or(
          isNotNull(notificationFacts.consumedAt),
          and(
            isNotNull(notificationFacts.expiresAt),
            sql`${notificationFacts.expiresAt} < excluded.created_at`,
          ),
        ),
      })
      .returning({ factKey: notificationFacts.factKey })
      .get()
    return row !== undefined
  }

  hasActive(factKey: string, target: string, now: string): boolean {
    const row = this.db
      .select({ one: sql<number>`1` })
      .from(notificationFacts)
      .where(
        and(
          eq(notificationFacts.factKey, factKey),
          eq(notificationFacts.target, target),
          isNull(notificationFacts.consumedAt),
          or(isNull(notificationFacts.expiresAt), gte(notificationFacts.expiresAt, now)),
        ),
      )
      .get()
    return row !== undefined
  }

  retire(factKey: string, target: string, consumedAt: string): boolean {
    const result = this.db
      .update(notificationFacts)
      .set({ consumedAt })
      .where(
        and(
          eq(notificationFacts.factKey, factKey),
          eq(notificationFacts.target, target),
          isNull(notificationFacts.consumedAt),
        ),
      )
      .run()
    return result.changes === 1
  }

  /** Retire every live claim for an exact fact_key (all targets). */
  retireFactKey(factKey: string, consumedAt: string): number {
    const result = this.db
      .update(notificationFacts)
      .set({ consumedAt })
      .where(and(eq(notificationFacts.factKey, factKey), isNull(notificationFacts.consumedAt)))
      .run()
    return Number(result.changes)
  }

  /**
   * Retire every live claim whose fact_key starts with `prefix` (all targets).
   * Fact keys use only alphanumerics and `:` / `-` — no LIKE wildcards.
   */
  retireFactKeyPrefix(prefix: string, consumedAt: string): number {
    const result = this.db
      .update(notificationFacts)
      .set({ consumedAt })
      .where(
        and(like(notificationFacts.factKey, `${prefix}%`), isNull(notificationFacts.consumedAt)),
      )
      .run()
    return Number(result.changes)
  }

  retireByIssue(issueId: IssueId): void {
    this.db.delete(notificationFacts).where(eq(notificationFacts.issueId, issueId)).run()
  }

  retireExpired(now: string): void {
    this.db
      .delete(notificationFacts)
      .where(and(isNotNull(notificationFacts.expiresAt), lt(notificationFacts.expiresAt, now)))
      .run()
  }
}

/**
 * Steward-facing fact arbiter. It owns clock/TTL policy while the repository owns
 * the atomic SQLite operation [spec:SP-ba61].
 */
export class NotificationArbiter {
  constructor(
    private readonly facts: NotificationFactsRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly defaultTtlMs = DEFAULT_TTL_MS,
  ) {}

  claim(
    factKey: string,
    target: string,
    opts: { source?: string; issueId?: IssueId; ttlMs?: number } = {},
  ): boolean {
    const createdAt = this.now()
    const ttlMs = opts.ttlMs ?? this.defaultTtlMs
    return this.facts.claim({
      factKey,
      target,
      source: opts.source ?? null,
      issueId: opts.issueId ?? null,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
    })
  }

  isClaimed(factKey: string, target: string): boolean {
    return this.facts.hasActive(factKey, target, this.now())
  }

  retire(factKey: string, target: string, at = this.now()): boolean {
    return this.facts.retire(factKey, target, at)
  }

  /** Retire every live claim for an exact fact_key (all targets). */
  retireFactKey(factKey: string, at = this.now()): number {
    return this.facts.retireFactKey(factKey, at)
  }

  /** Retire every live claim whose fact_key starts with `prefix` (all targets). */
  retireFactKeyPrefix(prefix: string, at = this.now()): number {
    return this.facts.retireFactKeyPrefix(prefix, at)
  }

  retireByIssue(issueId: IssueId): void {
    this.facts.retireByIssue(issueId)
  }

  retireExpired(now = this.now()): void {
    this.facts.retireExpired(now)
  }
}
