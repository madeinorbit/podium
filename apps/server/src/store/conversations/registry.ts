import { randomUUID } from 'node:crypto'
import { asConversationId, type ConversationId, type MachineId } from '@podium/model'
import { and, eq, isNotNull, isNull, like, max, sql } from 'drizzle-orm'
import { conversationIdentities, conversationSegments } from '../../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from '../executor/sync-drizzle'
import { inListOf, inListSize, inListValues, param, prepared, preparedFamily } from '../executor/sync-drizzle'

// Every query this repository runs, prepared once per store [POD-6147].

/** One segment by its key, over the `machineId` / `nativeId` placeholders. */
const segmentKey = () =>
  and(
    eq(conversationSegments.machineId, param(conversationSegments.machineId, 'machineId')),
    eq(conversationSegments.nativeId, param(conversationSegments.nativeId, 'nativeId')),
  )

const clearStraySubagentPaths = prepared((db: StoreDrizzle) =>
  db
    .update(conversationSegments)
    .set({ path: null })
    .where(
      and(
        like(conversationSegments.path, '%/subagents/%'),
        // The comparison is against a value built FROM THE ROW, so it is a
        // fragment rather than a bound parameter: a subagent path is repaired
        // unless it ends in its own native id.
        sql`${conversationSegments.path} NOT LIKE '%/' || ${conversationSegments.nativeId} || '.jsonl'`,
      ),
    )
    .prepare(),
)

const podiumIdOfSegment = prepared((db: StoreDrizzle) =>
  db
    .select({ podiumId: conversationSegments.podiumId })
    .from(conversationSegments)
    .where(segmentKey())
    .prepare(),
)

/** One machine's podium ids for a set of native ids (POD-6160). */
const podiumIdsOfSegments = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ nativeId: conversationSegments.nativeId, podiumId: conversationSegments.podiumId })
    .from(conversationSegments)
    .where(
      and(
        eq(conversationSegments.machineId, param(conversationSegments.machineId, 'machineId')),
        inListOf(conversationSegments.nativeId, size),
      ),
    )
    .prepare(),
)

/** The batch reads below are keyed by the chunk's prepared IN-list size; values are `in0`, `in1`, ... */
const segmentsWithPaths = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({
      machineId: conversationSegments.machineId,
      nativeId: conversationSegments.nativeId,
      podiumId: conversationSegments.podiumId,
      path: conversationSegments.path,
    })
    .from(conversationSegments)
    // SCOPED BY MACHINE, like every other lookup in this file. The caller
    // trusts the returned `machineId` as the transcript's identity, so an
    // unscoped match would let a path that also exists in another host's
    // segment rows attribute this daemon's spend to that host's session and
    // bank it under the wrong (machineId, nativeId) key.
    .where(
      and(
        eq(conversationSegments.machineId, param(conversationSegments.machineId, 'machineId')),
        inListOf(conversationSegments.path, size),
      ),
    )
    .prepare(),
)

const parentsOf = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({
      podiumId: conversationIdentities.podiumId,
      parentPodiumId: conversationIdentities.parentPodiumId,
    })
    .from(conversationIdentities)
    .where(
      and(
        isNotNull(conversationIdentities.parentPodiumId),
        inListOf(conversationIdentities.podiumId, size),
      ),
    )
    .prepare(),
)

const nativeIdsOf = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({
      podiumId: conversationSegments.podiumId,
      machineId: conversationSegments.machineId,
      nativeId: conversationSegments.nativeId,
    })
    .from(conversationSegments)
    .where(inListOf(conversationSegments.podiumId, size))
    .orderBy(conversationSegments.seqInConv)
    .prepare(),
)

const pathsOfNativeIds = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ nativeId: conversationSegments.nativeId, path: conversationSegments.path })
    .from(conversationSegments)
    .where(
      and(
        eq(conversationSegments.machineId, param(conversationSegments.machineId, 'machineId')),
        isNotNull(conversationSegments.path),
        inListOf(conversationSegments.nativeId, size),
      ),
    )
    .prepare(),
)

const pathOfSegment = prepared((db: StoreDrizzle) =>
  db
    .select({ path: conversationSegments.path })
    .from(conversationSegments)
    .where(segmentKey())
    .prepare(),
)

const adoptParent = prepared((db: StoreDrizzle) =>
  db
    .update(conversationIdentities)
    .set({ parentPodiumId: sql.placeholder('parentPodiumId') })
    .where(
      and(
        eq(conversationIdentities.podiumId, param(conversationIdentities.podiumId, 'podiumId')),
        isNull(conversationIdentities.parentPodiumId),
      ),
    )
    .prepare(),
)

// The trailing predicate is what keeps a re-discovery of an UNCHANGED
// segment free. Every sweep re-offers the whole corpus, so this matched
// its row and rewrote the same two values ~1656 times per 4 minutes on
// the live server (2026-08-12, POD-1931). Comparing with `IS NOT`
// against the value the SET would assign makes the no-op write vanish
// while a real change still lands.
const refreshSegmentFile = prepared((db: StoreDrizzle) => {
  const path = sql.placeholder('path')
  const reportedBytes = sql.placeholder('reportedBytes')
  return db
    .update(conversationSegments)
    .set({
      path: sql`COALESCE(${path}, ${conversationSegments.path})`,
      reportedBytes: sql`COALESCE(${reportedBytes}, ${conversationSegments.reportedBytes})`,
    })
    .where(
      and(
        segmentKey(),
        sql`(${conversationSegments.path} IS NOT COALESCE(${path}, ${conversationSegments.path})
                   OR ${conversationSegments.reportedBytes} IS NOT COALESCE(${reportedBytes}, ${conversationSegments.reportedBytes}))`,
      ),
    )
    .prepare()
})

const insertIdentity = prepared((db: StoreDrizzle) =>
  db
    .insert(conversationIdentities)
    .values({
      podiumId: sql.placeholder('podiumId'),
      parentPodiumId: sql.placeholder('parentPodiumId'),
      createdAt: sql.placeholder('createdAt'),
    })
    .prepare(),
)

const insertDiscoveredSegment = prepared((db: StoreDrizzle) =>
  db
    .insert(conversationSegments)
    .values({
      machineId: sql.placeholder('machineId'),
      nativeId: sql.placeholder('nativeId'),
      providerId: sql.placeholder('providerId'),
      podiumId: sql.placeholder('podiumId'),
      path: sql.placeholder('path'),
      reportedBytes: sql.placeholder('reportedBytes'),
      seqInConv: 1,
      linkedBy: 'discovery',
      createdAt: sql.placeholder('createdAt'),
    })
    .prepare(),
)

// THE MANY-CONVERSATION FORMS OF `ensure` [POD-6227]: a discovery reports a
// machine's whole corpus, and registering it one conversation at a time ran a
// read and one or two writes per conversation (about 3,300 statements for the
// 1,656 conversations a live sweep re-offered every four minutes). Each takes
// its rows as ONE bound JSON array, `rows`, read with json_each, so a statement
// has one shape for any number of rows, in the array's order.

/** The rows of the bound JSON array `rows`, and one field of the row a statement is reading. */
const offeredRows = () => sql`json_each(${sql.placeholder('rows')})`
const offered = (field: string) => sql.raw(`value ->> '$.${field}'`)

const insertIdentities = prepared((db: StoreDrizzle) =>
  db
    .insert(conversationIdentities)
    .select(
      db
        .select({
          podiumId: sql`${offered('podiumId')}`.as('podium_id'),
          parentPodiumId: sql`${offered('parentPodiumId')}`.as('parent_podium_id'),
          createdAt: sql`${sql.placeholder('createdAt')}`.as('created_at'),
        })
        .from(offeredRows()),
    )
    .prepare(),
)

const insertDiscoveredSegments = prepared((db: StoreDrizzle) =>
  db
    .insert(conversationSegments)
    .select(
      db
        .select({
          machineId: sql`${sql.placeholder('machineId')}`.as('machine_id'),
          nativeId: sql`${offered('nativeId')}`.as('native_id'),
          providerId: sql`${offered('providerId')}`.as('provider_id'),
          podiumId: sql`${offered('podiumId')}`.as('podium_id'),
          path: sql`${offered('path')}`.as('path'),
          reportedBytes: sql`${offered('reportedBytes')}`.as('reported_bytes'),
          seqInConv: sql`1`.as('seq_in_conv'),
          linkedBy: sql`'discovery'`.as('linked_by'),
          createdAt: sql`${sql.placeholder('createdAt')}`.as('created_at'),
        })
        .from(offeredRows()),
    )
    .prepare(),
)

/** {@link adoptParent} for many identities, one row each, for those that have none. */
const adoptParents = prepared((db: StoreDrizzle) =>
  db
    .update(conversationIdentities)
    .set({
      parentPodiumId: sql`(SELECT ${offered('parentPodiumId')} FROM ${offeredRows()}
        WHERE ${offered('podiumId')} = ${conversationIdentities.podiumId})`,
    })
    .where(
      and(
        isNull(conversationIdentities.parentPodiumId),
        sql`${conversationIdentities.podiumId} IN (SELECT ${offered('podiumId')} FROM ${offeredRows()})`,
      ),
    )
    .prepare(),
)

/**
 * {@link refreshSegmentFile} for many segments of one machine, at most one
 * row per native id, with the same trailing predicate: an unchanged segment
 * is not rewritten.
 */
const refreshSegmentFiles = prepared((db: StoreDrizzle) => {
  const of = (field: string) =>
    sql`(SELECT ${offered(field)} FROM ${offeredRows()} WHERE ${offered('nativeId')} = ${conversationSegments.nativeId})`
  const path = sql`COALESCE(${of('path')}, ${conversationSegments.path})`
  const reportedBytes = sql`COALESCE(${of('reportedBytes')}, ${conversationSegments.reportedBytes})`
  return db
    .update(conversationSegments)
    .set({ path, reportedBytes })
    .where(
      and(
        eq(conversationSegments.machineId, param(conversationSegments.machineId, 'machineId')),
        sql`${conversationSegments.nativeId} IN (SELECT ${offered('nativeId')} FROM ${offeredRows()})`,
        sql`(${conversationSegments.path} IS NOT ${path} OR ${conversationSegments.reportedBytes} IS NOT ${reportedBytes})`,
      ),
    )
    .prepare()
})

const highestSeqInConversation = prepared((db: StoreDrizzle) =>
  db
    .select({ m: max(conversationSegments.seqInConv) })
    .from(conversationSegments)
    .where(eq(conversationSegments.podiumId, param(conversationSegments.podiumId, 'podiumId')))
    .prepare(),
)

const insertRolledSegment = prepared((db: StoreDrizzle) =>
  db
    .insert(conversationSegments)
    .values({
      machineId: sql.placeholder('machineId'),
      nativeId: sql.placeholder('nativeId'),
      providerId: sql.placeholder('providerId'),
      podiumId: sql.placeholder('podiumId'),
      path: null,
      seqInConv: sql.placeholder('seqInConv'),
      linkedBy: 'live-roll',
      createdAt: sql.placeholder('createdAt'),
    })
    .prepare(),
)

const segmentsOfConversation = prepared((db: StoreDrizzle) =>
  db
    .select({
      machineId: conversationSegments.machineId,
      nativeId: conversationSegments.nativeId,
    })
    .from(conversationSegments)
    .where(eq(conversationSegments.podiumId, param(conversationSegments.podiumId, 'podiumId')))
    .orderBy(conversationSegments.seqInConv)
    .prepare(),
)

/** Stable Podium identities and the machine-native artifacts that evidence them.
 * RETAINED ID MINT: new ConversationIds are created from UUID-backed strings;
 * selected registry ids flow from the schema without re-entry casts. */
export class ConversationRegistryRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query capability, INJECTED rather than reached for [spec rule 27b]: the
   * store's one drizzle instance, whose executor routes each statement to the
   * current transaction.
   */
  private get db(): StoreDrizzle {
    return this.rootDb
  }

  async repairSubagentSegmentPaths(): Promise<void> {
    await clearStraySubagentPaths(this.db).run()
  }

  async podiumId(machineId: MachineId, nativeId: string): Promise<ConversationId | undefined> {
    const row = await podiumIdOfSegment(this.db).get({ machineId, nativeId })
    return row?.podiumId
  }

  /**
   * PATH → SEGMENT, for many paths at once (POD-1858).
   *
   * The one lookup the cost harvest does PER FILE. It is a batch rather than a
   * loop of `get`s because the harvest resolves every transcript the walk
   * touched in one pass, and because the 500-row chunking keeps it under
   * SQLite's variable limit on a box with a thousand active transcripts.
   */
  async segmentsByPaths(
    machineId: MachineId,
    paths: readonly string[],
  ): Promise<Map<string, { machineId: MachineId; nativeId: string; podiumId: ConversationId }>> {
    const out = new Map<
      string,
      { machineId: MachineId; nativeId: string; podiumId: ConversationId }
    >()
    for (const chunk of chunks(paths)) {
      const size = inListSize(chunk.length)
      const rows = await segmentsWithPaths(this.db, size).all(inListValues(chunk, size, 'in', { machineId }))
      for (const row of rows) {
        if (row.path === null || out.has(row.path)) continue
        out.set(row.path, {
          machineId: row.machineId,
          nativeId: row.nativeId,
          podiumId: row.podiumId,
        })
      }
    }
    return out
  }

  /**
   * The conversation each of these conversations is a child of.
   *
   * A subagent transcript has a segment row and no session of its own — its
   * cost belongs to the session that SPAWNED it, and this edge is how the
   * harvest finds that session. Fully populated on this machine: every one of
   * the 282 `subagents/` segments carries a parent.
   */
  async parentPodiumIds(podiumIds: readonly ConversationId[]): Promise<Map<ConversationId, ConversationId>> {
    const out = new Map<ConversationId, ConversationId>()
    for (const chunk of chunks(podiumIds)) {
      const size = inListSize(chunk.length)
      const rows = await parentsOf(this.db, size).all(inListValues(chunk, size))
      for (const row of rows) {
        if (row.parentPodiumId === null) continue
        out.set(row.podiumId, row.parentPodiumId)
      }
    }
    return out
  }

  /** The native ids evidencing each of these conversations, earliest segment first. */
  async nativeIdsByPodiumIds(podiumIds: readonly ConversationId[]): Promise<Map<ConversationId, string[]>> {
    const out = new Map<ConversationId, string[]>()
    for (const chunk of chunks(podiumIds)) {
      const size = inListSize(chunk.length)
      const rows = await nativeIdsOf(this.db, size).all(inListValues(chunk, size))
      for (const row of rows) {
        const list = out.get(row.podiumId)
        if (list) list.push(row.nativeId)
        else out.set(row.podiumId, [row.nativeId])
      }
    }
    return out
  }

  /**
   * The transcript path recorded for each of these native ids, batched.
   *
   * The cost read asks this about every session on a task at once — one query
   * rather than one per session, which on the biggest epic on this machine is 67
   * round trips saved from a panel's first paint.
   */
  async pathsByNativeIds(machineId: MachineId, nativeIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const chunk of chunks(nativeIds)) {
      const size = inListSize(chunk.length)
      const rows = await pathsOfNativeIds(this.db, size).all(inListValues(chunk, size, 'in', { machineId }))
      for (const row of rows) if (row.path !== null) out.set(row.nativeId, row.path)
    }
    return out
  }

  async segmentPath(machineId: MachineId, nativeId: string): Promise<string | undefined> {
    const row = await pathOfSegment(this.db).get({ machineId, nativeId })
    return row?.path ?? undefined
  }

  async ensure(opts: {
    machineId: MachineId
    nativeId: string
    providerId: string
    parentPodiumId?: ConversationId
    path?: string
    sizeBytes?: number
  }): Promise<ConversationId> {
    const existing = await this.podiumId(opts.machineId, opts.nativeId)
    if (existing !== undefined) {
      if (opts.parentPodiumId) {
        await adoptParent(this.db).run({ podiumId: existing, parentPodiumId: opts.parentPodiumId })
      }
      if (opts.path || opts.sizeBytes !== undefined) {
        await refreshSegmentFile(this.db).run({
          machineId: opts.machineId,
          nativeId: opts.nativeId,
          path: opts.path ?? null,
          reportedBytes: opts.sizeBytes ?? null,
        })
      }
      return existing
    }
    const podiumId = asConversationId(`conv_${randomUUID()}`)
    const now = new Date().toISOString()
    await insertIdentity(this.db).run({ podiumId, parentPodiumId: opts.parentPodiumId ?? null, createdAt: now })
    await insertDiscoveredSegment(this.db).run({
      machineId: opts.machineId,
      nativeId: opts.nativeId,
      providerId: opts.providerId,
      podiumId,
      path: opts.path ?? null,
      reportedBytes: opts.sizeBytes ?? null,
      createdAt: now,
    })
    return podiumId
  }

  /**
   * {@link ensure} for many conversations of one machine, in a fixed number of
   * statements [POD-6227]: one read of the ids already known (per 500), then at
   * most one write each for parents adopted, files refreshed, identities and
   * segments created. The result is what calling `ensure` for each entry in
   * order gives: a native id offered twice is created once, and its later
   * offers act on the existing row (the first parent wins, the last path and
   * size offered win).
   */
  async ensureMany(
    machineId: MachineId,
    entries: readonly {
      nativeId: string
      providerId: string
      parentPodiumId?: ConversationId
      path?: string
      sizeBytes?: number
    }[],
  ): Promise<Map<string, ConversationId>> {
    const ids = await this.podiumIds(machineId, entries.map((entry) => entry.nativeId))
    type Created = {
      nativeId: string
      providerId: string
      podiumId: ConversationId
      parentPodiumId: ConversationId | null
      path: string | null
      reportedBytes: number | null
    }
    const created = new Map<string, Created>()
    // The first parent offered for an identity: the single calls' IS NULL guard
    // let only the first one land.
    const adopted = new Map<ConversationId, { podiumId: ConversationId; parentPodiumId: ConversationId }>()
    const refreshed = new Map<string, { nativeId: string; path: string | null; reportedBytes: number | null }>()
    for (const entry of entries) {
      const fresh = created.get(entry.nativeId)
      const existing = ids.get(entry.nativeId)
      if (existing === undefined) {
        const podiumId = asConversationId(`conv_${randomUUID()}`)
        ids.set(entry.nativeId, podiumId)
        created.set(entry.nativeId, {
          nativeId: entry.nativeId,
          providerId: entry.providerId,
          podiumId,
          parentPodiumId: entry.parentPodiumId ?? null,
          path: entry.path ?? null,
          reportedBytes: entry.sizeBytes ?? null,
        })
        continue
      }
      // A later offer of a row this call creates folds into the row: the
      // single calls would have adopted and refreshed it after its insert.
      if (fresh) {
        if (entry.parentPodiumId && fresh.parentPodiumId === null) fresh.parentPodiumId = entry.parentPodiumId
        if (entry.path || entry.sizeBytes !== undefined) {
          fresh.path = entry.path ?? fresh.path
          fresh.reportedBytes = entry.sizeBytes ?? fresh.reportedBytes
        }
        continue
      }
      if (entry.parentPodiumId && !adopted.has(existing)) {
        adopted.set(existing, { podiumId: existing, parentPodiumId: entry.parentPodiumId })
      }
      if (entry.path || entry.sizeBytes !== undefined) {
        const prior = refreshed.get(entry.nativeId)
        refreshed.set(entry.nativeId, {
          nativeId: entry.nativeId,
          path: entry.path ?? prior?.path ?? null,
          reportedBytes: entry.sizeBytes ?? prior?.reportedBytes ?? null,
        })
      }
    }
    // Adoption and refresh touch only rows that existed before this call; the
    // rows it creates already carry every offer made for them.
    if (adopted.size > 0) await adoptParents(this.db).run({ rows: JSON.stringify([...adopted.values()]) })
    if (refreshed.size > 0) {
      await refreshSegmentFiles(this.db).run({ machineId, rows: JSON.stringify([...refreshed.values()]) })
    }
    if (created.size > 0) {
      const createdAt = new Date().toISOString()
      const rows = JSON.stringify([...created.values()])
      await insertIdentities(this.db).run({ rows, createdAt })
      await insertDiscoveredSegments(this.db).run({ machineId, rows, createdAt })
    }
    return ids
  }

  async linkSegment(opts: {
    machineId: MachineId
    newNativeId: string
    priorNativeId: string
    providerId: string
  }): Promise<ConversationId> {
    const already = await this.podiumId(opts.machineId, opts.newNativeId)
    if (already !== undefined) return already
    const podiumId = await this.ensure({
      machineId: opts.machineId,
      nativeId: opts.priorNativeId,
      providerId: opts.providerId,
    })
    const highest = await highestSeqInConversation(this.db).get({ podiumId })
    const nextSeq = (highest?.m ?? 0) + 1
    await insertRolledSegment(this.db).run({
      machineId: opts.machineId,
      nativeId: opts.newNativeId,
      providerId: opts.providerId,
      podiumId,
      seqInConv: nextSeq,
      createdAt: new Date().toISOString(),
    })
    return podiumId
  }

  /** {@link podiumId} for many native ids on one machine: the map is keyed by
   *  the ids asked for and a missing row stays missing. One statement per 500
   *  ids (POD-6160: the durable session records of a listing ask together). */
  async podiumIds(machineId: MachineId, nativeIds: readonly string[]): Promise<Map<string, ConversationId>> {
    const out = new Map<string, ConversationId>()
    const unique = [...new Set(nativeIds)]
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      const rows = await podiumIdsOfSegments(this.db, size).all({ machineId, ...inListValues(chunk, size) })
      for (const row of rows) out.set(row.nativeId, row.podiumId)
    }
    return out
  }

  async siblingSegments(
    machineId: MachineId,
    nativeId: string,
  ): Promise<{ machineId: MachineId; nativeId: string }[]> {
    const podiumId = await this.podiumId(machineId, nativeId)
    if (!podiumId) return []
    return await segmentsOfConversation(this.db).all({ podiumId })
  }

  /**
   * {@link siblingSegments} for many segments at once: for each key, in the
   * order given, every segment of the conversation it belongs to (earliest
   * first), or `[]` when it has no segment row. One statement per machine for
   * the podium ids and one for their segments, per 500 ids, however many keys
   * (POD-6215: the visibility pass of a conversation listing asks for every
   * row together).
   */
  async siblingSegmentsMany(
    keys: readonly { machineId: MachineId; nativeId: string }[],
  ): Promise<{ machineId: MachineId; nativeId: string }[][]> {
    const nativeIdsByMachine = new Map<MachineId, string[]>()
    for (const key of keys) {
      const list = nativeIdsByMachine.get(key.machineId)
      if (list) list.push(key.nativeId)
      else nativeIdsByMachine.set(key.machineId, [key.nativeId])
    }
    const podiumIdsByMachine = new Map<MachineId, Map<string, ConversationId>>()
    for (const [machineId, nativeIds] of nativeIdsByMachine) {
      podiumIdsByMachine.set(machineId, await this.podiumIds(machineId, nativeIds))
    }
    const segments = new Map<ConversationId, { machineId: MachineId; nativeId: string }[]>()
    const podiumIds = [...podiumIdsByMachine.values()].flatMap((byNative) => [...byNative.values()])
    for (const chunk of chunks(podiumIds)) {
      const size = inListSize(chunk.length)
      const rows = await nativeIdsOf(this.db, size).all(inListValues(chunk, size))
      for (const row of rows) {
        const segment = { machineId: row.machineId, nativeId: row.nativeId }
        const list = segments.get(row.podiumId)
        if (list) list.push(segment)
        else segments.set(row.podiumId, [segment])
      }
    }
    return keys.map((key) => {
      const podiumId = podiumIdsByMachine.get(key.machineId)?.get(key.nativeId)
      return podiumId ? [...(segments.get(podiumId) ?? [])] : []
    })
  }
}

/**
 * The 500-row chunking every batch read here uses, deduplicated first.
 *
 * SQLite's bound-variable limit is what sets the number, and the bound is per
 * STATEMENT — so a caller resolving a thousand transcripts issues two statements
 * rather than one that refuses. Unchanged from the four hand-written copies this
 * replaces, including the de-duplication, which is what makes the chunk count a
 * function of DISTINCT inputs.
 */
function* chunks<T>(values: readonly T[]): Generator<T[]> {
  const unique = [...new Set(values)]
  const CHUNK = 500
  for (let i = 0; i < unique.length; i += CHUNK) yield unique.slice(i, i + CHUNK)
}
