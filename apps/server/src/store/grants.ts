import { CommittedRows } from './committed-rows'
/**
 * Durable grant edges, never cached authorization decisions. Every reader asks
 * this repository; there is no in-memory copy (POD-6155), so a revocation is
 * visible to the next read, inside or outside the writing transaction.
 * The granter's CURRENT rights must still be evaluated at every decision.
 */

import type { GrantVerb } from '@podium/model'
import { GRANT_VERBS } from '@podium/model'
import { and, asc, count, eq, type SQL, sql } from 'drizzle-orm'
import { grantAudiences, grants } from '../migrations/schema'
import { operationLoader } from './executor/operation-loader'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { inListOf, inListSize, inListValues, param, prepared, preparedFamily } from './executor/sync-drizzle'

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

// Every query this repository runs, prepared once per store [POD-6147].

/** The historical audiences of many resources of one kind, in primary-key order [POD-6156]. */
const audiencesOf = preparedFamily((db: StoreDrizzle, size: number) =>
  db.select({ resourceId: grantAudiences.resourceId, grantee: grantAudiences.grantee }).from(grantAudiences)
    .where(and(
      eq(grantAudiences.resourceKind, param(grantAudiences.resourceKind, 'resourceKind')),
      inListOf(grantAudiences.resourceId, size, 'resourceIds'),
    ))
    .orderBy(asc(grantAudiences.resourceId), asc(grantAudiences.grantee)).prepare(),
)

const noteAudience = prepared((db: StoreDrizzle) =>
  db.insert(grantAudiences).values({
    resourceKind: sql.placeholder('resourceKind'),
    resourceId: sql.placeholder('resourceId'),
    grantee: sql.placeholder('grantee'),
  }).onConflictDoNothing().prepare(),
)

const grantsOfResource = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(grants)
    .where(and(
      eq(grants.resourceKind, param(grants.resourceKind, 'resourceKind')),
      eq(grants.resourceId, param(grants.resourceId, 'resourceId')),
    ))
    .orderBy(asc(grants.createdAt))
    .prepare(),
)

const grantsOfResources = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select()
    .from(grants)
    .where(and(eq(grants.resourceKind, param(grants.resourceKind, 'resourceKind')), inListOf(grants.resourceId, size)))
    .orderBy(asc(grants.createdAt))
    .prepare(),
)

// The grants of resources of SEVERAL kinds in one read [POD-6217]: every listed
// kind crossed with every listed id; the caller keeps only the (kind, id) pairs
// it asked for. Keyed by the two padded list sizes, `<kinds>x<ids>`.
const grantsOfResourceKeys = preparedFamily((db: StoreDrizzle, shape: string) => {
  const [kindSize, idSize] = shape.split('x').map(Number) as [number, number]
  return db
    .select()
    .from(grants)
    .where(and(inListOf(grants.resourceKind, kindSize, 'kind'), inListOf(grants.resourceId, idSize, 'id')))
    .orderBy(asc(grants.createdAt))
    .prepare()
})

/** `custody` keeps the stored marker when the row does not name one: two shapes. */
const upsertGrant = preparedFamily((db: StoreDrizzle, custody: 'set' | 'keep') =>
  db
    .insert(grants)
    .values({
      resourceKind: sql.placeholder('resourceKind'),
      resourceId: sql.placeholder('resourceId'),
      grantee: sql.placeholder('grantee'),
      verb: sql.placeholder('verb'),
      custody: sql.placeholder('custody'),
      owner: sql.placeholder('owner'),
      visibility: sql.placeholder('visibility'),
      createdAt: sql.placeholder('createdAt'),
      actorKind: sql.placeholder('actorKind'),
      actorId: sql.placeholder('actorId'),
      onBehalfOf: sql.placeholder('onBehalfOf'),
    })
    .onConflictDoUpdate({
      target: [grants.resourceKind, grants.resourceId, grants.grantee, grants.verb],
      set: {
        custody: custody === 'set' ? sql.placeholder('custody') : grants.custody,
        owner: sql.placeholder('owner'),
        visibility: sql.placeholder('visibility'),
        createdAt: sql.placeholder('createdAt'),
        actorKind: sql.placeholder('actorKind'),
        actorId: sql.placeholder('actorId'),
        onBehalfOf: sql.placeholder('onBehalfOf'),
      },
    }).returning().prepare(),
)

const oneEdge = (): SQL | undefined => and(
  eq(grants.resourceKind, param(grants.resourceKind, 'resourceKind')),
  eq(grants.resourceId, param(grants.resourceId, 'resourceId')),
  eq(grants.grantee, param(grants.grantee, 'grantee')),
  eq(grants.verb, param(grants.verb, 'verb')),
)

const countEdge = prepared((db: StoreDrizzle) =>
  db.select({ n: count() }).from(grants).where(oneEdge()).prepare(),
)

const deleteEdge = prepared((db: StoreDrizzle) =>
  db.delete(grants).where(oneEdge()).returning().prepare(),
)

const deleteGrantsOfGrantee = prepared((db: StoreDrizzle) =>
  db.delete(grants).where(eq(grants.grantee, param(grants.grantee, 'grantee'))).returning().prepare(),
)

const deleteGrantsOfResource = preparedFamily((db: StoreDrizzle, custody: 'retain' | 'all') =>
  db
    .delete(grants)
    .where(and(
      eq(grants.resourceKind, param(grants.resourceKind, 'resourceKind')),
      eq(grants.resourceId, param(grants.resourceId, 'resourceId')),
      ...(custody === 'retain' ? [eq(grants.custody, false)] : []),
    )).returning().prepare(),
)

/** One loader key per `(kind, id)`; NUL cannot occur in either. */
const resourceGrantKey = (kind: string, id: string): string => `${kind}\u0000${id}`
const splitResourceGrantKey = (key: string): [string, string] => {
  const at = key.indexOf('\u0000')
  return [key.slice(0, at), key.slice(at + 1)]
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

  /**
   * The historical audience of each resource, revoked readers included, in one
   * read per 500 ids [POD-6156]. Every asked id gets an entry, `[]` for "no
   * audience", its grantees in order.
   */
  async visibilityAudiencesFor(
    resourceKind: string,
    resourceIds: readonly string[],
  ): Promise<Map<string, readonly string[]>> {
    const out = new Map<string, string[]>()
    const unique = [...new Set(resourceIds)]
    for (const id of unique) out.set(id, [])
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500)
      const size = inListSize(chunk.length)
      const rows = await audiencesOf(this.db, size).all(
        inListValues(chunk, size, 'resourceIds', { resourceKind }),
      )
      for (const row of rows) out.get(row.resourceId)?.push(row.grantee)
    }
    return out
  }

  private async noteVisibilityAudience(resourceKind: string, resourceId: string, grantee: string): Promise<void> {
    await noteAudience(this.db).run({ resourceKind, resourceId, grantee })
  }
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'grants')
    // The loader is invalidated after each write below AND after each commit of
    // one, which is what makes its memo exact inside write spans (POD-6189).
    this.committed.subscribe(() => this.resourceGrants.invalidate())
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): StoreDrizzle {
    return this.rootDb
  }

  /**
   * Every edge on one resource (ADR 9 D2 rule 4). Live authorization requires
   * the caller to read under the lease that applies or publishes its decision.
   * Unparseable rows are omitted.
   */
  async listForResource(resourceKind: string, resourceId: string): Promise<GrantRow[]> {
    const rows = await grantsOfResource(this.db).all({ resourceKind, resourceId })
    return rows.flatMap((r) => {
      const row = grantFromRow(r)
      return row ? [row] : []
    })
  }

  /**
   * The same LIVE read as {@link listForResource}, asked about MANY resources at
   * once [POD-1653].
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
      const size = inListSize(chunk.length)
      const rows = await grantsOfResources(this.db, size).all(
        inListValues(chunk, size, 'in', { resourceKind }),
      )
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

  /**
   * {@link listForResource} through the operation's loader [POD-6149].
   *
   * An authorization pass asks "who may read this issue?" once per row, from
   * many call sites (`mayRead` callbacks). Asked in the same tick, those become
   * one {@link listForResources} query per resource kind; asked again later in
   * the same operation (read scope), they are answered from the loader. Outside
   * an explicit scope and outside a write span it is exactly one live read.
   * Every grant write below invalidates it, so an operation sees its own grant
   * changes.
   *
   * FOR THE WHOLE OPERATION, WRITE SPANS INCLUDED [POD-6189]. A daemon frame or
   * a tRPC call asked about the same session three to five times (an access
   * check before its span, the projection inside it, reprojections after it),
   * each a statement. The loader now memoises for the operation
   * (`operation-scope.ts`). Every grant write goes through this repository and
   * invalidates the loader after the write and after its commit, so an answer
   * the loader holds is what the table holds now; a span's own writes move its
   * later reads to a memo on the span frame, so a savepoint rollback takes them
   * with it (`operation-loader.ts`). Nothing outlives the operation.
   */
  async loadForResource(resourceKind: string, resourceId: string): Promise<GrantRow[]> {
    return (await this.resourceGrants.load(resourceGrantKey(resourceKind, resourceId))) ?? []
  }

  /**
   * {@link loadForResource} for several resources of one kind at once: the
   * operation's memo answers the ones it holds, and the rest are one query.
   * Every asked id has an entry, `[]` for none.
   */
  async loadForResources(resourceKind: string, resourceIds: readonly string[]): Promise<Map<string, GrantRow[]>> {
    return (await this.loadForResourcesOfKinds({ [resourceKind]: resourceIds })).get(resourceKind) ?? new Map()
  }

  /**
   * {@link loadForResources} for resources of SEVERAL kinds at once [POD-6217]:
   * the misses of every kind are one query, not one per kind. Asked as
   * `{ issue: [...], session: [...] }`; every asked kind and id has an entry,
   * `[]` for none.
   *
   * A write's passes ask about the same session under two rules: the session's
   * access check and its projection read the grants of its issue (or of the
   * session when it has none), the feed's visibility pass reads the session's
   * own grants. A caller that knows both are coming asks for both here, so the
   * operation reads them in one statement and the later pass finds them in the
   * memo.
   */
  async loadForResourcesOfKinds(
    resources: Readonly<Record<string, readonly string[]>>,
  ): Promise<Map<string, Map<string, GrantRow[]>>> {
    const keys = Object.entries(resources).flatMap(([kind, ids]) => ids.map((id) => resourceGrantKey(kind, id)))
    const loaded = await this.resourceGrants.loadMany(keys)
    return new Map(
      Object.entries(resources).map(([kind, ids]) => [
        kind,
        new Map(ids.map((id) => [id, loaded.get(resourceGrantKey(kind, id)) ?? []])),
      ]),
    )
  }

  /**
   * The grants of every `(kind, id)` key, in ONE read per 500 ids whatever the
   * mix of kinds [POD-6217]. The read crosses the kinds with the ids, so it
   * keeps only the pairs asked for; every asked key has an entry, `[]` for none,
   * because "no edges" is an answer, and it is the one the loader must remember.
   */
  private async listForResourceKeys(keys: readonly string[]): Promise<Map<string, GrantRow[]>> {
    const found = new Map<string, GrantRow[]>()
    for (const key of keys) found.set(key, [])
    const kinds = new Set<string>()
    const ids = new Set<string>()
    for (const key of found.keys()) {
      const [kind, id] = splitResourceGrantKey(key)
      kinds.add(kind)
      ids.add(id)
    }
    const kindList = [...kinds]
    const kindSize = inListSize(kindList.length)
    const idList = [...ids]
    // The kinds take a few of SQLite's 999 bound parameters; 500 ids leave room.
    for (let at = 0; at < idList.length; at += 500) {
      const chunk = idList.slice(at, at + 500)
      const idSize = inListSize(chunk.length)
      const rows = await grantsOfResourceKeys(this.db, `${kindSize}x${idSize}`).all(
        inListValues(chunk, idSize, 'id', inListValues(kindList, kindSize, 'kind')),
      )
      for (const r of rows) {
        const row = grantFromRow(r)
        if (row) found.get(resourceGrantKey(row.resourceKind, row.resourceId))?.push(row)
      }
    }
    return found
  }

  private readonly resourceGrants = operationLoader<string, GrantRow[]>(
    async (keys) => await this.listForResourceKeys(keys),
    { copy: (rows) => rows.map((row) => ({ ...row })), perOperation: true },
  )

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
      return await upsertGrant(this.db, row.custody === undefined ? 'keep' : 'set').all({
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
      })
    }, 'upsert')
    this.resourceGrants.invalidate()
    this.visibilityRevisionValue += 1
  }

  /** Revocation of one verb. Returns whether an edge was actually removed, so a
   *  caller can tell "revoked" from "there was nothing to revoke" without a
   *  second read that could race the delete. */
  async remove(resourceKind: string, resourceId: string, grantee: string, verb: GrantVerb): Promise<boolean> {
    const edge = { resourceKind, resourceId, grantee, verb }
    const before = await countEdge(this.db).get(edge)
    await this.committed.write(async () => {
      await this.noteVisibilityAudience(resourceKind, resourceId, grantee)
      return await deleteEdge(this.db).all(edge)
    }, 'delete')
    this.resourceGrants.invalidate()
    const removed = (before?.n ?? 0) > 0
    if (removed) this.visibilityRevisionValue += 1
    return removed
  }

  /** Member removal revokes their incoming rights, preserving everyone else's shares. */
  async removeAllForGrantee(grantee: string): Promise<void> {
    const result = await this.committed.write(async () => await deleteGrantsOfGrantee(this.db)
      .all({ grantee }), 'delete')
    this.resourceGrants.invalidate()
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
    const result = await this.committed.write(async () => await deleteGrantsOfResource(this.db, retainCustody ? 'retain' : 'all')
      .all({ resourceKind, resourceId }), 'delete')
    this.resourceGrants.invalidate()
    if (Number(result.changes) > 0) this.visibilityRevisionValue += 1
  }
}
