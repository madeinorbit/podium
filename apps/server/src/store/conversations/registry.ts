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

  async podiumIds(machineId: MachineId, nativeIds: string[]): Promise<Map<string, ConversationId>> {
    const out = new Map<string, ConversationId>()
    // ONE STATEMENT PER NATIVE ID, exactly as before. Batching this is a
    // behaviour question rather than a rewrite — the caller's map is keyed by
    // the ids it asked for and a missing row must stay missing — so it is left
    // for the read-scope work (B0.6) rather than decided in a conversion.
    for (const nativeId of nativeIds) {
      const row = await podiumIdOfSegment(this.db).get({ machineId, nativeId })
      if (row) out.set(nativeId, row.podiumId)
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
