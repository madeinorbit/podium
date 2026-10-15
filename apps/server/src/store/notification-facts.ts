import type { IssueId } from '@podium/model'
import { and, eq, gte, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm'
import { notificationFacts } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

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
// Every query this repository runs, prepared once per store [POD-6147].

// A WRITE THAT RETURNS ROWS, and the exact statement POD-3318 was found on:
// drizzle emits `INSERT ... RETURNING` through the `all` decoder, so nothing
// may read write intent off the method. `.returning()` on an insert IS the
// declaration (spec rule 27a), and the terminal `.get()` only says how many
// rows come back.
const claimFact = prepared((db: StoreDrizzle) =>
  db
    .insert(notificationFacts)
    .values({
      factKey: sql.placeholder('factKey'),
      target: sql.placeholder('target'),
      source: sql.placeholder('source'),
      issueId: sql.placeholder('issueId'),
      createdAt: sql.placeholder('createdAt'),
      expiresAt: sql.placeholder('expiresAt'),
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
    .prepare(),
)

const factKeyIs = () => eq(notificationFacts.factKey, param(notificationFacts.factKey, 'factKey'))
const targetIs = () => eq(notificationFacts.target, param(notificationFacts.target, 'target'))

const activeFact = prepared((db: StoreDrizzle) =>
  db
    .select({ one: sql<number>`1` })
    .from(notificationFacts)
    .where(
      and(
        factKeyIs(),
        targetIs(),
        isNull(notificationFacts.consumedAt),
        or(
          isNull(notificationFacts.expiresAt),
          gte(notificationFacts.expiresAt, param(notificationFacts.expiresAt, 'now')),
        ),
      ),
    )
    .prepare(),
)

const retireFact = prepared((db: StoreDrizzle) =>
  db
    .update(notificationFacts)
    .set({ consumedAt: sql.placeholder('consumedAt') })
    .where(and(factKeyIs(), targetIs(), isNull(notificationFacts.consumedAt)))
    .prepare(),
)

const retireFactsOfKey = prepared((db: StoreDrizzle) =>
  db
    .update(notificationFacts)
    .set({ consumedAt: sql.placeholder('consumedAt') })
    .where(and(factKeyIs(), isNull(notificationFacts.consumedAt)))
    .prepare(),
)

const retireFactsOfKeyPrefix = prepared((db: StoreDrizzle) =>
  db
    .update(notificationFacts)
    .set({ consumedAt: sql.placeholder('consumedAt') })
    .where(
      and(
        like(notificationFacts.factKey, sql.placeholder('pattern')),
        isNull(notificationFacts.consumedAt),
      ),
    )
    .prepare(),
)

const deleteFactsOfIssue = prepared((db: StoreDrizzle) =>
  db
    .delete(notificationFacts)
    .where(eq(notificationFacts.issueId, param(notificationFacts.issueId, 'issueId')))
    .prepare(),
)

const deleteExpiredFacts = prepared((db: StoreDrizzle) =>
  db
    .delete(notificationFacts)
    .where(
      and(
        isNotNull(notificationFacts.expiresAt),
        lt(notificationFacts.expiresAt, param(notificationFacts.expiresAt, 'now')),
      ),
    )
    .prepare(),
)

export class NotificationFactsRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b], and
   * read through a getter rather than frozen into a field [rule 34a]. Ambient
   * transaction routing (rule 35) has to resolve the ENCLOSING transaction on
   * every access, which a field assigned once in a constructor can never do — so
   * B1 changes the one line inside this getter and no call site below it.
   */
  private get db(): StoreDrizzle {
    return this.rootDb
  }

  /**
   * Insert a new claim, or refresh a retired claim. The conflict guard is part of
   * the single write statement, so concurrent producers cannot both win.
   */
  async claim(fact: FactClaim): Promise<boolean> {
    // A write that returns rows: see `claimFact`.
    const row = await claimFact(this.db).get({
      factKey: fact.factKey,
      target: fact.target,
      source: fact.source,
      issueId: fact.issueId,
      createdAt: fact.createdAt,
      expiresAt: fact.expiresAt,
    })
    return row !== undefined
  }

  async hasActive(factKey: string, target: string, now: string): Promise<boolean> {
    const row = await activeFact(this.db).get({ factKey, target, now })
    return row !== undefined
  }

  async retire(factKey: string, target: string, consumedAt: string): Promise<boolean> {
    const result = await retireFact(this.db).run({ factKey, target, consumedAt })
    return result.changes === 1
  }

  /** Retire every live claim for an exact fact_key (all targets). */
  async retireFactKey(factKey: string, consumedAt: string): Promise<number> {
    const result = await retireFactsOfKey(this.db).run({ factKey, consumedAt })
    return Number(result.changes)
  }

  /**
   * Retire every live claim whose fact_key starts with `prefix` (all targets).
   * Fact keys use only alphanumerics and `:` / `-` — no LIKE wildcards.
   */
  async retireFactKeyPrefix(prefix: string, consumedAt: string): Promise<number> {
    const result = await retireFactsOfKeyPrefix(this.db).run({ pattern: `${prefix}%`, consumedAt })
    return Number(result.changes)
  }

  async retireByIssue(issueId: IssueId): Promise<void> {
    await deleteFactsOfIssue(this.db).run({ issueId })
  }

  async retireExpired(now: string): Promise<void> {
    await deleteExpiredFacts(this.db).run({ now })
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

  async claim(
    factKey: string,
    target: string,
    opts: { source?: string; issueId?: IssueId; ttlMs?: number } = {},
  ): Promise<boolean> {
    const createdAt = this.now()
    const ttlMs = opts.ttlMs ?? this.defaultTtlMs
    return await this.facts.claim({
      factKey,
      target,
      source: opts.source ?? null,
      issueId: opts.issueId ?? null,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
    })
  }

  async isClaimed(factKey: string, target: string): Promise<boolean> {
    return await this.facts.hasActive(factKey, target, this.now())
  }

  async retire(factKey: string, target: string, at = this.now()): Promise<boolean> {
    return await this.facts.retire(factKey, target, at)
  }

  /** Retire every live claim for an exact fact_key (all targets). */
  async retireFactKey(factKey: string, at = this.now()): Promise<number> {
    return await this.facts.retireFactKey(factKey, at)
  }

  /** Retire every live claim whose fact_key starts with `prefix` (all targets). */
  async retireFactKeyPrefix(prefix: string, at = this.now()): Promise<number> {
    return await this.facts.retireFactKeyPrefix(prefix, at)
  }

  async retireByIssue(issueId: IssueId): Promise<void> {
    await this.facts.retireByIssue(issueId)
  }

  async retireExpired(now = this.now()): Promise<void> {
    await this.facts.retireExpired(now)
  }
}
