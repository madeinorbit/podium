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
import type { SqlDatabase } from '@podium/runtime/sqlite'

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

function toRow(r: Record<string, unknown>): GrantRow | undefined {
  const verb = parseVerb(r.verb)
  if (verb === undefined) return undefined
  return {
    resourceKind: r.resource_kind as string,
    resourceId: r.resource_id as string,
    grantee: r.grantee as string,
    verb,
    owner: r.owner as string,
    visibility: r.visibility as string,
    createdAt: r.created_at as string,
    actorKind: r.actor_kind as string,
    actorId: (r.actor_id as string | null | undefined) ?? null,
    onBehalfOf: (r.on_behalf_of as string | null | undefined) ?? null,
  }
}

export class GrantsRepository {
  private readonly visibilityAudiences = new Map<string, Set<string>>()

  visibilityAudienceFor(resourceKind: string, resourceId: string): readonly string[] {
    return [...(this.visibilityAudiences.get(resourceKind + ':' + resourceId) ?? [])]
  }

  private noteVisibilityAudience(resourceKind: string, resourceId: string, grantee: string): void {
    const key = resourceKind + ':' + resourceId
    const audience = this.visibilityAudiences.get(key) ?? new Set<string>()
    audience.add(grantee)
    this.visibilityAudiences.set(key, audience)
  }
  constructor(private readonly db: SqlDatabase) {}

  /** Every edge on one resource, read LIVE (D16.1). Unparseable rows are omitted. */
  listForResource(resourceKind: string, resourceId: string): GrantRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM grants WHERE resource_kind = ? AND resource_id = ? ORDER BY created_at ASC',
      )
      .all(resourceKind, resourceId) as Record<string, unknown>[]
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
        .prepare(
          `SELECT * FROM grants
             WHERE resource_kind = ? AND resource_id IN (${chunk.map(() => '?').join(',')})
             ORDER BY created_at ASC`,
        )
        .all(resourceKind, ...chunk) as Record<string, unknown>[]
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
      .prepare('SELECT * FROM grants WHERE resource_kind = ? ORDER BY created_at ASC')
      .all(resourceKind) as Record<string, unknown>[]
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
    this.db
      .prepare(
        `INSERT OR REPLACE INTO grants
           (resource_kind, resource_id, grantee, verb, owner, visibility, created_at, actor_kind, actor_id, on_behalf_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.resourceKind,
        row.resourceId,
        row.grantee,
        row.verb,
        row.owner,
        row.visibility,
        row.createdAt,
        row.actorKind,
        row.actorId,
        row.onBehalfOf,
      )
  }

  /** Revocation of one verb. Returns whether an edge was actually removed, so a
   *  caller can tell "revoked" from "there was nothing to revoke" without a
   *  second read that could race the delete. */
  remove(resourceKind: string, resourceId: string, grantee: string, verb: GrantVerb): boolean {
    this.noteVisibilityAudience(resourceKind, resourceId, grantee)
    const before = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM grants WHERE resource_kind = ? AND resource_id = ? AND grantee = ? AND verb = ?',
      )
      .get(resourceKind, resourceId, grantee, verb) as { n: number } | undefined
    this.db
      .prepare(
        'DELETE FROM grants WHERE resource_kind = ? AND resource_id = ? AND grantee = ? AND verb = ?',
      )
      .run(resourceKind, resourceId, grantee, verb)
    return (before?.n ?? 0) > 0
  }

  /**
   * Drop every edge on a resource — called when the resource itself goes away.
   *
   * A machine that is revoked and later re-paired reuses its id (the daemon
   * keeps it), so surviving edges would silently re-grant a machine its previous
   * owner already un-shared. This is not a reaper: it is part of the delete.
   */
  removeAllForResource(resourceKind: string, resourceId: string): void {
    this.db
      .prepare('DELETE FROM grants WHERE resource_kind = ? AND resource_id = ?')
      .run(resourceKind, resourceId)
  }
}
