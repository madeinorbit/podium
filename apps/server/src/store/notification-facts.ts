import type { SqlDatabase } from '@podium/runtime/sqlite'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

interface FactClaim {
  factKey: string
  target: string
  source: string | null
  issueId: string | null
  createdAt: string
  expiresAt: string | null
}

/** Durable atomic claims behind the steward's notification arbiter [spec:SP-ba61]. */
export class NotificationFactsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Insert a new claim, or refresh a retired claim. The conflict guard is part of
   * the single write statement, so concurrent producers cannot both win.
   */
  claim(fact: FactClaim): boolean {
    const row = this.db
      .prepare(
        `INSERT INTO notification_facts
           (fact_key, target, source, issue_id, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(fact_key, target) DO UPDATE SET
           source = excluded.source,
           issue_id = excluded.issue_id,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           consumed_at = NULL
         WHERE notification_facts.consumed_at IS NOT NULL
            OR (notification_facts.expires_at IS NOT NULL
                AND notification_facts.expires_at < excluded.created_at)
         RETURNING fact_key`,
      )
      .get(fact.factKey, fact.target, fact.source, fact.issueId, fact.createdAt, fact.expiresAt)
    return row !== undefined
  }

  retireByIssue(issueId: string): void {
    this.db.prepare('DELETE FROM notification_facts WHERE issue_id = ?').run(issueId)
  }

  retireExpired(now: string): void {
    this.db
      .prepare('DELETE FROM notification_facts WHERE expires_at IS NOT NULL AND expires_at < ?')
      .run(now)
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
    opts: { source?: string; issueId?: string; ttlMs?: number } = {},
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

  retireByIssue(issueId: string): void {
    this.facts.retireByIssue(issueId)
  }

  retireExpired(now = this.now()): void {
    this.facts.retireExpired(now)
  }
}
