/**
 * THE GRANT EDGE TABLE (POD-1079) — the persistence half of POD-1075's
 * `GrantEdge` model type, and the first writer the `grants` table has ever had.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STORED IS AN EDGE, NOT A DECISION
 * ---------------------------------------------------------------------------
 *
 * ADR 9 D2 rule 4: *"A grant is not a copy of rights. It is evaluated live
 * against the granter's CURRENT rights."* So this repository has no `can()`, no
 * effective-rights query and no cache. It answers ONE question — which edges
 * exist on this resource right now — and `machine-access.ts` computes the
 * verdict from that plus the row's current owner, at every apply.
 *
 * The consequence that matters operationally: revocation is `DELETE`, and the
 * next decision is already correct. There is no reaper to write and therefore
 * none to forget (the same reason the model type has no `expiresAt`).
 *
 * ---------------------------------------------------------------------------
 * WHY THE READ IS PER-RESOURCE AND NOT A WHOLE-TABLE LOAD
 * ---------------------------------------------------------------------------
 *
 * Every `use` check names one machine. A cached whole-table read would be a
 * SECOND source of truth for "who may run code on this laptop", and the failure
 * mode is the one D16.1 names by hand: a revoked grant that keeps working until
 * something invalidates a cache. `MachinesService` caches machine ROWS for the
 * hot listing path; grants are deliberately not in that cache.
 */

import type { GrantVerb } from '@podium/model'
import { GRANT_VERBS } from '@podium/model'
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import { grants } from '../migrations/schema'
import type { SyncDrizzle } from './executor/sync-drizzle'

/** The entity kind a machine grant hangs on — `ENTITY_KINDS`' `machine` member. */
export const MACHINE_RESOURCE_KIND = 'machine'

/** One stored edge, in the vocabulary the gate consumes. */
export interface GrantRow {
  resourceKind: string
  resourceId: string
  /** WHOM (a `UserId`; group grantees are ADR 9 D2's deferred additive change). */
  grantee: string
  verb: GrantVerb
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

function toRow(r: GrantSelection): GrantRow | undefined {
  const verb = parseVerb(r.verb)
  if (verb === undefined) return undefined
  return {
    resourceKind: r.resourceKind,
    resourceId: r.resourceId,
    grantee: r.grantee,
    verb,
    owner: r.owner,
    visibility: r.visibility,
    createdAt: r.createdAt,
    actorKind: r.actorKind,
    actorId: r.actorId,
    onBehalfOf: r.onBehalfOf,
  }
}

export class GrantsRepository {
  private readonly visibilityAudiences = new Map<string, Set<string>>()
  /**
   * Process-local authority generation for caches that retain a scoped answer.
   *
   * Grant writes can change who sees a row even when the entity upsert declared
   * beside them deduplicates at the change-log head. A scoped cache must validate
   * against this authority signal as well as the feed cursor; the cursor alone is
   * not a visibility validator.
   */
  private visibilityRevisionValue = 0

  visibilityRevision(): number {
    return this.visibilityRevisionValue
  }

  visibilityAudienceFor(resourceKind: string, resourceId: string): readonly string[] {
    return [...(this.visibilityAudiences.get(resourceKind + ':' + resourceId) ?? [])]
  }

  /**
   * The resource ids of one kind that this process has noted an audience for
   * [POD-3261].
   *
   * The set {@link visibilityAudienceFor} can answer non-empty for, enumerated
   * — which is what lets a caller that would otherwise ask per resource ask
   * once. It reads the same in-memory map and takes no query, so a caller may
   * use it to SIZE a batched read; it is not itself an authorization answer and
   * nothing may be decided from membership in it. `visibilityAudienceFor`
   * remains the only door to the audience.
   */
  visibilityAudienceResourceIds(resourceKind: string): string[] {
    const prefix = `${resourceKind}:`
    const ids: string[] = []
    for (const key of this.visibilityAudiences.keys()) {
      if (key.startsWith(prefix)) ids.push(key.slice(prefix.length))
    }
    return ids
  }

  private noteVisibilityAudience(resourceKind: string, resourceId: string, grantee: string): void {
    const key = resourceKind + ':' + resourceId
    const audience = this.visibilityAudiences.get(key) ?? new Set<string>()
    audience.add(grantee)
    this.visibilityAudiences.set(key, audience)
  }
  constructor(private readonly db: SyncDrizzle) {}

  /** Every edge on one resource, read LIVE (D16.1). Unparseable rows are omitted. */
  listForResource(resourceKind: string, resourceId: string): GrantRow[] {
    const rows = this.db
      .select()
      .from(grants)
      .where(and(eq(grants.resourceKind, resourceKind), eq(grants.resourceId, resourceId)))
      .orderBy(asc(grants.createdAt))
      .all()
    return rows.flatMap((r) => {
      const row = toRow(r)
      return row ? [row] : []
    })
  }

  /**
   * The same LIVE read as {@link listForResource}, asked about MANY resources at
   * once [POD-1653].
   *
   * This is a batching change, explicitly not a caching one — the header above
   * rules a cache out, and for a reason that still holds: a revoked grant must
   * stop working at the next decision, and a whole-table read held across
   * decisions would be a second source of truth for "who may run code on this
   * laptop". Every row here is read from SQLite at the moment of asking, exactly
   * as the per-resource form does; the only thing that changes is how many
   * round-trips one pass costs.
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
  listForResources(resourceKind: string, resourceIds: readonly string[]): Map<string, GrantRow[]> {
    const out = new Map<string, GrantRow[]>()
    const unique = [...new Set(resourceIds)]
    if (unique.length === 0) return out
    // SQLITE_MAX_VARIABLE_NUMBER is 999 on the builds this ships against, and
    // the kind occupies one of them. Chunking keeps a 1200-session pass from
    // failing at the driver rather than merely being slow.
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      const rows = this.db
        .select()
        .from(grants)
        .where(and(eq(grants.resourceKind, resourceKind), inArray(grants.resourceId, chunk)))
        .orderBy(asc(grants.createdAt))
        .all()
      for (const r of rows) {
        const row = toRow(r)
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
  listForKind(resourceKind: string): GrantRow[] {
    const rows = this.db
      .select()
      .from(grants)
      .where(eq(grants.resourceKind, resourceKind))
      .orderBy(asc(grants.createdAt))
      .all()
    return rows.flatMap((r) => {
      const row = toRow(r)
      return row ? [row] : []
    })
  }

  /**
   * Write an edge. `INSERT OR REPLACE` on the PK `(kind, id, grantee, verb)`:
   * re-sharing the same verb with the same person is idempotent and re-stamps
   * the granter, which is what makes a re-share by a NEW owner accountable to
   * that owner rather than to the previous one.
   */
  upsert(row: GrantRow): void {
    this.noteVisibilityAudience(row.resourceKind, row.resourceId, row.grantee)
    // `grants` carries its four-column primary key and NO second uniqueness
    // constraint, so `ON CONFLICT` on that key is `INSERT OR REPLACE` exactly
    // (checklist item 1, as amended: every column is named).
    this.db
      .insert(grants)
      .values({
        resourceKind: row.resourceKind,
        resourceId: row.resourceId,
        grantee: row.grantee,
        verb: row.verb,
        owner: row.owner,
        visibility: row.visibility,
        createdAt: row.createdAt,
        actorKind: row.actorKind,
        actorId: row.actorId,
        onBehalfOf: row.onBehalfOf,
      })
      .onConflictDoUpdate({
        target: [grants.resourceKind, grants.resourceId, grants.grantee, grants.verb],
        set: {
          owner: row.owner,
          visibility: row.visibility,
          createdAt: row.createdAt,
          actorKind: row.actorKind,
          actorId: row.actorId,
          onBehalfOf: row.onBehalfOf,
        },
      })
      .run()
    this.visibilityRevisionValue += 1
  }

  /** Revocation of one verb. Returns whether an edge was actually removed, so a
   *  caller can tell "revoked" from "there was nothing to revoke" without a
   *  second read that could race the delete. */
  remove(resourceKind: string, resourceId: string, grantee: string, verb: GrantVerb): boolean {
    this.noteVisibilityAudience(resourceKind, resourceId, grantee)
    const match = and(
      eq(grants.resourceKind, resourceKind),
      eq(grants.resourceId, resourceId),
      eq(grants.grantee, grantee),
      eq(grants.verb, verb),
    )
    const before = this.db.select({ n: count() }).from(grants).where(match).get()
    this.db.delete(grants).where(match).run()
    const removed = (before?.n ?? 0) > 0
    if (removed) this.visibilityRevisionValue += 1
    return removed
  }

  /**
   * Drop every edge on a resource — called when the resource itself goes away.
   *
   * A machine that is revoked and later re-paired reuses its id (the daemon
   * keeps it), so surviving edges would silently re-grant a machine its previous
   * owner already un-shared. This is not a reaper: it is part of the delete.
   */
  removeAllForResource(resourceKind: string, resourceId: string): void {
    const result = this.db
      .delete(grants)
      .where(and(eq(grants.resourceKind, resourceKind), eq(grants.resourceId, resourceId)))
      .run()
    if (Number(result.changes) > 0) this.visibilityRevisionValue += 1
  }
}
