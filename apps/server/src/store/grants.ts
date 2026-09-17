import { CommittedRows } from './committed-rows'
/**
 * Durable grant edges, never cached authorization decisions. Existing readers
 * still query this repository. WorldIndex separately mirrors these rows through
 * the mandatory commit application: a revocation and its in-memory edge removal
 * commit together, so there is no cache invalidation or stale-rights interval.
 * The granter's CURRENT rights must still be evaluated at every decision.
 */

import type { GrantVerb } from '@podium/model'
import { GRANT_VERBS } from '@podium/model'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { grantAudiences, grants } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { currentTransaction } from './executor/sync-drizzle'

/** The entity kind a machine grant hangs on — `ENTITY_KINDS`' `machine` member. */
export const MACHINE_RESOURCE_KIND = 'machine'

/** One stored edge, in the vocabulary the gate consumes. */
export interface GrantRow {
  resourceKind: string
  resourceId: string
  /** WHOM (a `UserId`; group grantees are ADR 9 D2's deferred additive change). */
  grantee: string
  verb: GrantVerb
  custody?: boolean
  /** The GRANTER — the accountable party, stored in `Ownership.owner`'s column
   *  rather than a second `granter` one (see the model type's header). */
  owner: string
  visibility: string
  createdAt: string
  /** WHICH PRINCIPAL performed the share: `user` / `agent` / `system`. */
  actorKind: string
  actorId: string | null
  onBehalfOf: string | null
}

/**
 * Verb parsing, and it FAILS CLOSED.
 *
 * A row whose `verb` column holds something this build has never heard of —
 * written by a newer version, or corrupted — must not be admitted as a grant.
 * Returning the string unchanged would let an unknown verb through every `has`
 * check that happens to compare it, which is the unknown-input-fails-open shape.
 * Unparseable edges are DROPPED from the answer, so an unreadable grant denies.
 */
const parseVerb = (raw: unknown): GrantVerb | undefined =>
  typeof raw === 'string' && (GRANT_VERBS as readonly string[]).includes(raw)
    ? (raw as GrantVerb)
    : undefined

type GrantSelection = typeof grants.$inferSelect

export function grantFromRow(r: GrantSelection): GrantRow | undefined {
  const verb = parseVerb(r.verb)
  if (verb === undefined) return undefined
  return {
    resourceKind: r.resourceKind,
    resourceId: r.resourceId,
    grantee: r.grantee,
    verb,
    ...(r.custody ? { custody: true } : {}),
    owner: r.owner,
    visibility: r.visibility,
    createdAt: r.createdAt,
    actorKind: r.actorKind,
    actorId: r.actorId,
    onBehalfOf: r.onBehalfOf,
  }
}

export class GrantsRepository {
  readonly committed: CommittedRows<typeof grants.$inferSelect>

  /**
   * Process-local authority generation for caches that retain a scoped answer.
   *
   * Grant writes can change who sees a row even when the entity upsert declared
   * beside them deduplicates at the change-log head. A scoped cache must validate
   * against this authority signal as well as the feed cursor; the cursor alone is
   * not a visibility validator.
   */
  private visibilityRevisionValue = 0

  async visibilityRevision(): Promise<number> {
    return this.visibilityRevisionValue
  }

  async visibilityAudienceFor(resourceKind: string, resourceId: string): Promise<readonly string[]> {
    const rows = await this.db.select({ grantee: grantAudiences.grantee }).from(grantAudiences)
      .where(and(eq(grantAudiences.resourceKind, resourceKind), eq(grantAudiences.resourceId, resourceId)))
      .orderBy(asc(grantAudiences.grantee)).all()
    return rows.map(row => row.grantee)
  }

  /** Historical resource ids, including resources whose last grant was revoked. */
  async visibilityAudienceResourceIds(resourceKind: string): Promise<string[]> {
    const rows = await this.db.selectDistinct({ resourceId: grantAudiences.resourceId }).from(grantAudiences)
      .where(eq(grantAudiences.resourceKind, resourceKind)).orderBy(asc(grantAudiences.resourceId)).all()
    return rows.map(row => row.resourceId)
  }

  private async noteVisibilityAudience(resourceKind: string, resourceId: string, grantee: string): Promise<void> {
    await this.db.insert(grantAudiences).values({ resourceKind, resourceId, grantee }).onConflictDoNothing().run()
  }
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'grants')
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): StoreDrizzle {
    return currentTransaction() ?? this.rootDb
  }

  /**
   * Every edge on one resource (ADR 9 D2 rule 4). Live authorization requires
   * the caller to read under the lease that applies or publishes its decision.
   * Unparseable rows are omitted.
   */
  async listForResource(resourceKind: string, resourceId: string): Promise<GrantRow[]> {
    const rows = await this.db
      .select()
      .from(grants)
      .where(and(eq(grants.resourceKind, resourceKind), eq(grants.resourceId, resourceId)))
      .orderBy(asc(grants.createdAt))
      .all()
    return rows.flatMap((r) => {
      const row = grantFromRow(r)
      return row ? [row] : []
    })
  }

  /**
   * The same LIVE read as {@link listForResource}, asked about MANY resources at
   * once [POD-1653].
   *
   * This API remains a live batched read. WorldIndex is a separate committed
   * fact capability; switching authorization callers belongs to the child issues.
   *
   * Why it was needed: a reader-scoped session projection asked this question
   * once per session, and for the ~1145 sessions with no issue the resource key
   * is the session's own id — unique per row, so nothing could ever coalesce
   * them. That was ~8000 statements per pass returning ZERO rows on the live
   * host, because the resources genuinely have no grants.
   *
   * The result includes NO entry for a resource with no edges. That absence is
   * the answer, and a caller must read it as "no grants", never as "not looked
   * at" — {@link primeOwnerMemo} depends on exactly that distinction.
   */
  async listForResources(resourceKind: string, resourceIds: readonly string[]): Promise<Map<string, GrantRow[]>> {
    const out = new Map<string, GrantRow[]>()
    const unique = [...new Set(resourceIds)]
    if (unique.length === 0) return out
    // SQLITE_MAX_VARIABLE_NUMBER is 999 on the builds this ships against, and
    // the kind occupies one of them. Chunking keeps a 1200-session pass from
    // failing at the driver rather than merely being slow.
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      const rows = await this.db
        .select()
        .from(grants)
        .where(and(eq(grants.resourceKind, resourceKind), inArray(grants.resourceId, chunk)))
        .orderBy(asc(grants.createdAt))
        .all()
      for (const r of rows) {
        const row = grantFromRow(r)
        if (!row) continue
        const bucket = out.get(row.resourceId)
        if (bucket) bucket.push(row)
        else out.set(row.resourceId, [row])
      }
    }
    return out
  }

  /** Every edge on every resource of one kind — the fleet-wide read the machine
   *  listing needs, so N machines cost one query rather than N. */
  async listForKind(resourceKind: string): Promise<GrantRow[]> {
    const rows = await this.db
      .select()
      .from(grants)
      .where(eq(grants.resourceKind, resourceKind))
      .orderBy(asc(grants.createdAt))
      .all()
    return rows.flatMap((r) => {
      const row = grantFromRow(r)
      return row ? [row] : []
    })
  }

  /** One boot statement, sharing the same fail-closed decoder as live reads. */
  async loadWorldGrants(): Promise<GrantRow[]> {
    return (await this.db.select().from(grants).orderBy(asc(grants.createdAt)).all())
      .flatMap((row) => { const grant = grantFromRow(row); return grant ? [grant] : [] })
  }

  /**
   * Write an edge. `INSERT OR REPLACE` on the PK `(kind, id, grantee, verb)`:
   * re-sharing the same verb with the same person is idempotent and re-stamps
   * the granter, which is what makes a re-share by a NEW owner accountable to
   * that owner rather than to the previous one.
   */
  async upsert(row: GrantRow): Promise<void> {
    if (row.custody && (row.resourceKind !== 'machine' || row.verb !== 'manage')) {
      throw new Error('Custody requires a machine manage edge')
    }
    // Updating an ordinary share preserves its custody marker. A second
    // custodian conflicts with the partial unique index and rolls back.
    ;await this.committed.write(async () => {
      await this.noteVisibilityAudience(row.resourceKind, row.resourceId, row.grantee)
      return (this.db
      .insert(grants)
      .values({
        resourceKind: row.resourceKind,
        resourceId: row.resourceId,
        grantee: row.grantee,
        verb: row.verb,
        custody: row.custody ?? false,
        owner: row.owner,
        visibility: row.visibility,
        createdAt: row.createdAt,
        actorKind: row.actorKind,
        actorId: row.actorId,
        onBehalfOf: row.onBehalfOf,
      }))
      .onConflictDoUpdate({
        target: [grants.resourceKind, grants.resourceId, grants.grantee, grants.verb],
        set: {
          custody: row.custody ?? grants.custody,
          owner: row.owner,
          visibility: row.visibility,
          createdAt: row.createdAt,
          actorKind: row.actorKind,
          actorId: row.actorId,
          onBehalfOf: row.onBehalfOf,
        },
      }).returning().all()
    }, 'upsert')
    this.visibilityRevisionValue += 1
  }

  /** Revocation of one verb. Returns whether an edge was actually removed, so a
   *  caller can tell "revoked" from "there was nothing to revoke" without a
   *  second read that could race the delete. */
  async remove(resourceKind: string, resourceId: string, grantee: string, verb: GrantVerb): Promise<boolean> {
    const match = and(
      eq(grants.resourceKind, resourceKind),
      eq(grants.resourceId, resourceId),
      eq(grants.grantee, grantee),
      eq(grants.verb, verb),
    )
    const before = await this.db.select({ n: count() }).from(grants).where(match).get()
    await this.committed.write(async () => {
      await this.noteVisibilityAudience(resourceKind, resourceId, grantee)
      return this.db.delete(grants).where(match).returning().all()
    }, 'delete')
    const removed = (before?.n ?? 0) > 0
    if (removed) this.visibilityRevisionValue += 1
    return removed
  }

  /** Member removal revokes their incoming rights, preserving everyone else's shares. */
  async removeAllForGrantee(grantee: string): Promise<void> {
    const result = await this.committed.write(async () => this.db.delete(grants)
      .where(eq(grants.grantee, grantee)).returning().all(), 'delete')
    if (result.changes > 0) this.visibilityRevisionValue += 1
  }

  /**
   * Drop resource edges. Retained revoked machine rows keep their custody edge
   * solely for audit visibility and explicit replacement authorization.
   *
   * A machine that is revoked and later re-paired reuses its id (the daemon
   * keeps it), so surviving edges would silently re-grant a machine its previous
   * owner already un-shared. This is not a reaper: it is part of the delete.
   */
  async removeAllForResource(resourceKind: string, resourceId: string, retainCustody = false): Promise<void> {
    const result = await this.committed.write(async () => this.db
      .delete(grants)
      .where(and(eq(grants.resourceKind, resourceKind), eq(grants.resourceId, resourceId), ...(retainCustody ? [eq(grants.custody, false)] : []))).returning().all(), 'delete')
    if (Number(result.changes) > 0) this.visibilityRevisionValue += 1
  }
}
