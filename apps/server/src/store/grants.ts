// workspace-scoped (POD-6959)
import { captureWrite } from '../sync/capture-pg'
import { CommittedRows } from './committed-rows'
import { MachineRecordWrites } from './machine-record-writes'
/**
 * Durable grant edges, never cached authorization decisions. Every reader asks
 * this repository; there is no in-memory copy (POD-6155), so a revocation is
 * visible to the next read, inside or outside the writing transaction.
 * The granter's CURRENT rights must still be evaluated at every decision.
 */

import type { GrantVerb } from '@podium/model'
import { ALL_MEMBERS_GRANTEE, GRANT_VERBS } from '@podium/model'
import { asc, eq, type SQL, sql } from 'drizzle-orm'
import type { grants } from '../migrations/schema'
import { operationLoader } from './executor/operation-loader'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  WORKSPACE,
} from './executor/sync-drizzle'

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
const audiencesOf = preparedFamily((db, t, size: number) =>
  db
    .select({ resourceId: t.grantAudiences.resourceId, grantee: t.grantAudiences.grantee })
    .from(t.grantAudiences)
    .where(
      inWorkspace(
        t.grantAudiences,
        eq(t.grantAudiences.resourceKind, param(t.grantAudiences.resourceKind, 'resourceKind')),
        inListOf(t.grantAudiences.resourceId, size, 'resourceIds'),
      ),
    )
    .orderBy(asc(t.grantAudiences.resourceId), asc(t.grantAudiences.grantee))
    .prepare(),
)

const noteAudience = prepared((db, t) =>
  db
    .insert(t.grantAudiences)
    .values({
      workspaceId: WORKSPACE,
      resourceKind: sql.placeholder('resourceKind'),
      resourceId: sql.placeholder('resourceId'),
      grantee: sql.placeholder('grantee'),
    })
    .onConflictDoNothing()
    .prepare(),
)

// Edges written together share a created_at (an enrollment writes use and
// manage at once), so the rest of the primary key breaks the tie: a resource's
// edges always come back in one order [POD-6596].
const grantsOfResource = prepared((db, t) =>
  db
    .select()
    .from(t.grants)
    .where(
      inWorkspace(
        t.grants,
        eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
        eq(t.grants.resourceId, param(t.grants.resourceId, 'resourceId')),
      ),
    )
    .orderBy(asc(t.grants.createdAt), asc(t.grants.grantee), asc(t.grants.verb))
    .prepare(),
)

const grantsOfResources = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.grants)
    .where(
      inWorkspace(
        t.grants,
        eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
        inListOf(t.grants.resourceId, size),
      ),
    )
    .orderBy(asc(t.grants.createdAt), asc(t.grants.grantee), asc(t.grants.verb))
    .prepare(),
)

// The grants of resources of SEVERAL kinds in one read [POD-6217]: every listed
// kind crossed with every listed id; the caller keeps only the (kind, id) pairs
// it asked for. Keyed by the two padded list sizes, `<kinds>x<ids>`.
const grantsOfResourceKeys = preparedFamily((db, t, shape: string) => {
  const [kindSize, idSize] = shape.split('x').map(Number) as [number, number]
  return db
    .select()
    .from(t.grants)
    .where(
      inWorkspace(
        t.grants,
        inListOf(t.grants.resourceKind, kindSize, 'kind'),
        inListOf(t.grants.resourceId, idSize, 'id'),
      ),
    )
    .orderBy(asc(t.grants.createdAt), asc(t.grants.grantee), asc(t.grants.verb))
    .prepare()
})

// The edges of one resource kind given to any of several grantees (a person and
// the groups they belong to), served by `idx_grants_grantee`.
const grantsToGrantees = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.grants)
    .where(
      inWorkspace(
        t.grants,
        eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
        inListOf(t.grants.grantee, size, 'grantees'),
      ),
    )
    .prepare(),
)

/** `custody` keeps the stored marker when the row does not name one: two shapes. */
const upsertGrant = preparedFamily((db, t, custody: 'set' | 'keep') =>
  captureWrite(
    db
      .insert(t.grants)
      .values({
        workspaceId: WORKSPACE,
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
        target: [
          t.grants.workspaceId,
          t.grants.resourceKind,
          t.grants.resourceId,
          t.grants.grantee,
          t.grants.verb,
        ],
        set: {
          custody: custody === 'set' ? sql.placeholder('custody') : t.grants.custody,
          owner: sql.placeholder('owner'),
          visibility: sql.placeholder('visibility'),
          createdAt: sql.placeholder('createdAt'),
          actorKind: sql.placeholder('actorKind'),
          actorId: sql.placeholder('actorId'),
          onBehalfOf: sql.placeholder('onBehalfOf'),
        },
      })
      .returning(),
  ).prepare(),
)

const oneEdge = (t: StoreTables): SQL | undefined =>
  inWorkspace(
    t.grants,
    eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
    eq(t.grants.resourceId, param(t.grants.resourceId, 'resourceId')),
    eq(t.grants.grantee, param(t.grants.grantee, 'grantee')),
    eq(t.grants.verb, param(t.grants.verb, 'verb')),
  )

const deleteEdge = prepared((db, t) =>
  captureWrite(db.delete(t.grants).where(oneEdge(t)).returning()).prepare(),
)

/** A revoked credential manager's downstream edges, through the resource's primary-key prefix. */
const deleteGrantsGivenOnResource = preparedFamily((db, t, size: number) =>
  captureWrite(
    db
      .delete(t.grants)
      .where(
        inWorkspace(
          t.grants,
          eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
          eq(t.grants.resourceId, param(t.grants.resourceId, 'resourceId')),
          inListOf(t.grants.owner, size, 'granters'),
        ),
      )
      .returning(),
  ).prepare(),
)

const deleteGrantsOfGrantee = prepared((db, t) =>
  captureWrite(
    db
      .delete(t.grants)
      .where(inWorkspace(t.grants, eq(t.grants.grantee, param(t.grants.grantee, 'grantee'))))
      .returning(),
  ).prepare(),
)

/** The group grantee every member is in (`ALL_MEMBERS_GRANTEE`); never a manager. */
const ALL_MEMBERS = ALL_MEMBERS_GRANTEE

/** The resource kind of a credential's grant edges (`CREDENTIAL_RESOURCE_KIND`). */
const CREDENTIAL_KIND = 'credential'

/**
 * The credentials one person owns, by id (POD-7594, final review N1): read
 * through `idx_credentials_owner`, so the shares of a removed member's keys can
 * end in the removal's own transaction.
 */
const credentialIdsOfOwner = prepared((db, t) =>
  db
    .select({ id: t.credentials.id })
    .from(t.credentials)
    .where(
      inWorkspace(
        t.credentials,
        eq(t.credentials.ownerUserId, param(t.credentials.ownerUserId, 'ownerUserId')),
      ),
    )
    .prepare(),
)

/** Every grant on these credentials, through the primary key's `(resource_kind, resource_id)`. */
const deleteGrantsOfCredentials = preparedFamily((db, t, size: number) =>
  captureWrite(
    db
      .delete(t.grants)
      .where(
        inWorkspace(
          t.grants,
          eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
          inListOf(t.grants.resourceId, size, 'resourceIds'),
        ),
      )
      .returning(),
  ).prepare(),
)

/**
 * The credentials a person manages without owning them, by their incoming
 * `manage` edges (POD-7594, final review 2): the only keys on which they can
 * have given anything. Through `idx_grants_grantee`.
 */
const credentialsManagedBy = prepared((db, t) =>
  db
    .select({ id: t.grants.resourceId })
    .from(t.grants)
    .where(
      inWorkspace(
        t.grants,
        eq(t.grants.grantee, param(t.grants.grantee, 'grantee')),
        eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
        eq(t.grants.verb, param(t.grants.verb, 'verb')),
      ),
    )
    .prepare(),
)

/** The owners of these credentials, through the credentials primary key. */
const ownersOfCredentials = preparedFamily((db, t, size: number) =>
  db
    .select({ id: t.credentials.id, owner: t.credentials.ownerUserId })
    .from(t.credentials)
    .where(inWorkspace(t.credentials, inListOf(t.credentials.id, size, 'ids')))
    .prepare(),
)

/**
 * The edges one person gave on these credentials, handed to a new granter: the
 * key's owner (POD-7594, final review 2). Through the primary key's
 * `(resource_kind, resource_id)` prefix.
 */
const reparentGrantsOnCredentials = preparedFamily((db, t, size: number) =>
  captureWrite(
    db
      .update(t.grants)
      .set({ owner: sql.placeholder('newOwner') })
      .where(
        inWorkspace(
          t.grants,
          eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
          inListOf(t.grants.resourceId, size, 'resourceIds'),
          eq(t.grants.owner, param(t.grants.owner, 'formerOwner')),
        ),
      )
      .returning(),
  ).prepare(),
)

/**
 * The edges one person gave on these credentials that no longer reach the
 * owner (POD-7594, M1 check R1): dead already, so they go with the person
 * rather than come back on a re-invite. Through the primary key's prefix.
 */
const deleteGrantsGivenOnCredentials = preparedFamily((db, t, size: number) =>
  captureWrite(
    db
      .delete(t.grants)
      .where(
        inWorkspace(
          t.grants,
          eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
          inListOf(t.grants.resourceId, size, 'resourceIds'),
          eq(t.grants.owner, param(t.grants.owner, 'formerOwner')),
        ),
      )
      .returning(),
  ).prepare(),
)

const machinesGrantedTo = prepared((db, t) =>
  db
    .select({ id: t.grants.resourceId })
    .from(t.grants)
    .where(
      inWorkspace(
        t.grants,
        eq(t.grants.grantee, param(t.grants.grantee, 'grantee')),
        eq(t.grants.resourceKind, 'machine'),
      ),
    )
    .prepare(),
)

const deleteGrantsOfResource = preparedFamily((db, t, custody: 'retain' | 'all') =>
  captureWrite(
    db
      .delete(t.grants)
      .where(
        inWorkspace(
          t.grants,
          eq(t.grants.resourceKind, param(t.grants.resourceKind, 'resourceKind')),
          eq(t.grants.resourceId, param(t.grants.resourceId, 'resourceId')),
          ...(custody === 'retain' ? [eq(t.grants.custody, false)] : []),
        ),
      )
      .returning(),
  ).prepare(),
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

  async machineIdsForGrantee(grantee: string): Promise<string[]> {
    return (await machinesGrantedTo(this.db).all({ grantee })).map(({ id }) => id)
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

  private async noteVisibilityAudience(
    resourceKind: string,
    resourceId: string,
    grantee: string,
  ): Promise<void> {
    await noteAudience(this.db).run({ resourceKind, resourceId, grantee })
  }
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(
    queries: WorkspaceQueries,
    readonly machineRecordWrites = new MachineRecordWrites(),
  ) {
    this.committed = new CommittedRows(queries.createOrJoinTransaction, 'grants')
    // The loader is invalidated after each write below AND after each commit of
    // one, which is what makes its memo exact inside write spans (POD-6189).
    this.committed.subscribe(() => this.resourceGrants.invalidate())
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): WorkspaceDb {
    return this.scope
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
  async listForResources(
    resourceKind: string,
    resourceIds: readonly string[],
  ): Promise<Map<string, GrantRow[]>> {
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
   * Every edge on a resource of one kind given to one of `grantees` (a person and
   * the groups that include them). Live, like {@link listForResource}; the caller
   * still checks each granter's current standing.
   */
  async listForGrantees(resourceKind: string, grantees: readonly string[]): Promise<GrantRow[]> {
    const unique = [...new Set(grantees)]
    if (unique.length === 0) return []
    const size = inListSize(unique.length)
    const rows = await grantsToGrantees(this.db, size).all(
      inListValues(unique, size, 'grantees', { resourceKind }),
    )
    return rows.flatMap((r) => {
      const row = grantFromRow(r)
      return row ? [row] : []
    })
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
  async loadForResources(
    resourceKind: string,
    resourceIds: readonly string[],
  ): Promise<Map<string, GrantRow[]>> {
    return (
      (await this.loadForResourcesOfKinds({ [resourceKind]: resourceIds })).get(resourceKind) ??
      new Map()
    )
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
    const keys = Object.entries(resources).flatMap(([kind, ids]) =>
      ids.map((id) => resourceGrantKey(kind, id)),
    )
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
    await this.machineRecordWrites.compare(async () => {
      if (row.custody && (row.resourceKind !== 'machine' || row.verb !== 'manage')) {
        throw new Error('Custody requires a machine manage edge')
      }
      // Updating an ordinary share preserves its custody marker. A second
      // custodian conflicts with the partial unique index and rolls back.
      await this.committed.write(async () => {
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
    })
  }

  /**
   * Revoke one verb. Revoking credential manage also deletes everything given
   * through it, in the same transaction, so a later re-grant restores nothing.
   * Returns whether an edge was actually removed, from the delete's own rows.
   */
  async remove(
    resourceKind: string,
    resourceId: string,
    grantee: string,
    verb: GrantVerb,
  ): Promise<boolean> {
    return this.machineRecordWrites.compare(async () => {
      const edge = { resourceKind, resourceId, grantee, verb }
      const result = await this.committed.write(async () => {
        await this.noteVisibilityAudience(resourceKind, resourceId, grantee)
        const deleted = await deleteEdge(this.db).all(edge)
        if (resourceKind !== CREDENTIAL_KIND || verb !== 'manage' || deleted.length === 0) {
          return deleted
        }
        const [credential] = await ownersOfCredentials(this.db, 1).all(
          inListValues([resourceId], 1, 'ids'),
        )
        // Ownership is implicit: a redundant incoming edge cannot revoke it.
        if (grantee === credential?.owner) return deleted
        const edges = await this.listForResource(resourceKind, resourceId)
        const children = new Map<string, string[]>()
        for (const grant of edges) {
          if (
            grant.verb === 'manage' &&
            grant.grantee !== credential?.owner &&
            grant.grantee !== ALL_MEMBERS
          ) {
            const group = children.get(grant.owner) ?? []
            group.push(grant.grantee)
            children.set(grant.owner, group)
          }
        }
        // The primary key permits one incoming manage edge per person. Each
        // manager below the revoked edge therefore depends on that edge alone.
        // A Set also terminates malformed cycles; the credential owner is never
        // a dependent manager, even if an edge points back to them.
        const dependent = new Set([grantee])
        for (const granter of dependent) {
          for (const child of children.get(granter) ?? []) dependent.add(child)
        }
        const granters = [...dependent]
        for (let at = 0; at < granters.length; at += 500) {
          const chunk = granters.slice(at, at + 500)
          const size = inListSize(chunk.length)
          const rows = await deleteGrantsGivenOnResource(this.db, size).all(
            inListValues(chunk, size, 'granters', { resourceKind, resourceId }),
          )
          for (const row of rows) deleted.push(row)
        }
        return deleted
      }, 'delete')
      this.resourceGrants.invalidate()
      const removed = result.changes > 0
      if (removed) this.visibilityRevisionValue += 1
      return removed
    })
  }

  /** Member removal revokes their incoming rights, preserving everyone else's shares. */
  /**
   * Remove every grant on the credentials `ownerUserId` owns (a removed member,
   * POD-7594): one read of their ids, then one delete per 500 of them.
   */
  async removeCredentialGrantsOfOwner(ownerUserId: string): Promise<void> {
    const ids = (await credentialIdsOfOwner(this.db).all({ ownerUserId })).map((row) => row.id)
    if (ids.length === 0) return
    await this.machineRecordWrites.compare(async () => {
      let changes = 0
      for (let at = 0; at < ids.length; at += 500) {
        const chunk = ids.slice(at, at + 500)
        const size = inListSize(chunk.length)
        const result = await this.committed.write(
          async () =>
            await deleteGrantsOfCredentials(this.db, size).all(
              inListValues(chunk, size, 'resourceIds', { resourceKind: CREDENTIAL_KIND }),
            ),
          'delete',
        )
        changes += result.changes
      }
      this.resourceGrants.invalidate()
      if (changes > 0) this.visibilityRevisionValue += 1
    })
  }

  /**
   * A member is being removed (POD-7594, operator decision and final review 2):
   * the `use` and `manage` edges they gave on someone else's key are handed to
   * that key's owner, so the people they shared it with keep access, the owner
   * can revoke it, and no edge needs the removed person. Run before their
   * incoming grants are deleted; nothing they held then comes back if the
   * same member id is invited again.
   *
   * ONLY WHAT STILL REACHES THE OWNER (M1 check, R1). Per key, the managers are
   * worked out from the owner as `accessFrom` does: the owner, then whoever a
   * manager with a member row (`hasMemberRow`) gave `manage`. Where the person
   * is one of them, their edges are handed over; where the owner had already
   * cut the chain above them, their edges are dead and are deleted, so the
   * removal never revives access the owner took back.
   */
  async reparentCredentialGrantsGivenBy(
    formerOwner: string,
    hasMemberRow: (ids: readonly string[]) => Promise<ReadonlySet<string>>,
  ): Promise<void> {
    const managed = [
      ...new Set(
        (
          await credentialsManagedBy(this.db).all({
            grantee: formerOwner,
            resourceKind: CREDENTIAL_KIND,
            verb: 'manage',
          })
        ).map((row) => row.id),
      ),
    ]
    if (managed.length === 0) return
    const ownerOf = new Map<string, string>()
    for (let at = 0; at < managed.length; at += 500) {
      const chunk = managed.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await ownersOfCredentials(this.db, size).all(
        inListValues(chunk, size, 'ids'),
      )) {
        if (row.owner !== formerOwner) ownerOf.set(row.id, row.owner)
      }
    }
    const edgesOf = await this.listForResources(CREDENTIAL_KIND, [...ownerOf.keys()])
    const givers = new Set<string>()
    for (const [id, edges] of edgesOf) {
      givers.add(ownerOf.get(id) ?? '')
      for (const edge of edges) givers.add(edge.owner)
    }
    givers.delete('')
    const live = await hasMemberRow([...givers])
    const handOver = new Map<string, string[]>()
    const dead: string[] = []
    for (const [id, owner] of ownerOf) {
      const edges = edgesOf.get(id) ?? []
      const managers = new Set<string>([owner])
      let grew = true
      while (grew) {
        grew = false
        for (const edge of edges) {
          if (
            edge.verb === 'manage' &&
            edge.grantee !== ALL_MEMBERS &&
            !managers.has(edge.grantee) &&
            managers.has(edge.owner) &&
            live.has(edge.owner)
          ) {
            managers.add(edge.grantee)
            grew = true
          }
        }
      }
      if (managers.has(formerOwner)) handOver.set(owner, [...(handOver.get(owner) ?? []), id])
      else dead.push(id)
    }
    await this.machineRecordWrites.compare(async () => {
      let changes = 0
      for (const [newOwner, ids] of handOver) {
        for (let at = 0; at < ids.length; at += 500) {
          const chunk = ids.slice(at, at + 500)
          const size = inListSize(chunk.length)
          const result = await this.committed.write(
            async () =>
              await reparentGrantsOnCredentials(this.db, size).all(
                inListValues(chunk, size, 'resourceIds', {
                  resourceKind: CREDENTIAL_KIND,
                  formerOwner,
                  newOwner,
                }),
              ),
            // The reparented rows, as they are now.
            'upsert',
          )
          changes += result.changes
        }
      }
      for (let at = 0; at < dead.length; at += 500) {
        const chunk = dead.slice(at, at + 500)
        const size = inListSize(chunk.length)
        const result = await this.committed.write(
          async () =>
            await deleteGrantsGivenOnCredentials(this.db, size).all(
              inListValues(chunk, size, 'resourceIds', {
                resourceKind: CREDENTIAL_KIND,
                formerOwner,
              }),
            ),
          'delete',
        )
        changes += result.changes
      }
      this.resourceGrants.invalidate()
      if (changes > 0) this.visibilityRevisionValue += 1
    })
  }

  async removeAllForGrantee(grantee: string): Promise<void> {
    await this.machineRecordWrites.compare(async () => {
      const result = await this.committed.write(
        async () => await deleteGrantsOfGrantee(this.db).all({ grantee }),
        'delete',
      )
      this.resourceGrants.invalidate()
      if (result.changes > 0) this.visibilityRevisionValue += 1
    })
  }

  /**
   * Drop resource edges. Retained revoked machine rows keep their custody edge
   * solely for audit visibility and explicit replacement authorization.
   *
   * A machine that is revoked and later re-paired reuses its id (the daemon
   * keeps it), so surviving edges would silently re-grant a machine its previous
   * owner already un-shared. This is not a reaper: it is part of the delete.
   */
  async removeAllForResource(
    resourceKind: string,
    resourceId: string,
    retainCustody = false,
  ): Promise<void> {
    await this.machineRecordWrites.compare(async () => {
      const result = await this.committed.write(
        async () =>
          await deleteGrantsOfResource(this.db, retainCustody ? 'retain' : 'all').all({
            resourceKind,
            resourceId,
          }),
        'delete',
      )
      this.resourceGrants.invalidate()
      if (Number(result.changes) > 0) this.visibilityRevisionValue += 1
    })
  }
}
