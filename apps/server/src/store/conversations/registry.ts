import { randomUUID } from 'node:crypto'
import { asConversationId, type ConversationId, type MachineId } from '@podium/model'
import { and, eq, inArray, isNotNull, isNull, like, max, sql } from 'drizzle-orm'
import { conversationIdentities, conversationSegments } from '../../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from '../executor/sync-drizzle'

/** Stable Podium identities and the machine-native artifacts that evidence them. */
export class ConversationRegistryRepository {
  private readonly rootDb: SyncDrizzle
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
  private get db(): SyncDrizzle {
    return this.rootDb
  }

  repairSubagentSegmentPaths(): void {
    this.db
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
      .run()
  }

  podiumId(machineId: MachineId, nativeId: string): ConversationId | undefined {
    const row = this.db
      .select({ podiumId: conversationSegments.podiumId })
      .from(conversationSegments)
      .where(this.segment(machineId, nativeId))
      .get()
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
  segmentsByPaths(
    machineId: MachineId,
    paths: readonly string[],
  ): Map<string, { machineId: MachineId; nativeId: string; podiumId: ConversationId }> {
    const out = new Map<
      string,
      { machineId: MachineId; nativeId: string; podiumId: ConversationId }
    >()
    for (const chunk of chunks(paths)) {
      const rows = this.db
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
            eq(conversationSegments.machineId, machineId),
            inArray(conversationSegments.path, chunk),
          ),
        )
        .all()
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
  parentPodiumIds(podiumIds: readonly ConversationId[]): Map<ConversationId, ConversationId> {
    const out = new Map<ConversationId, ConversationId>()
    for (const chunk of chunks(podiumIds)) {
      const rows = this.db
        .select({
          podiumId: conversationIdentities.podiumId,
          parentPodiumId: conversationIdentities.parentPodiumId,
        })
        .from(conversationIdentities)
        .where(
          and(
            isNotNull(conversationIdentities.parentPodiumId),
            inArray(conversationIdentities.podiumId, chunk),
          ),
        )
        .all()
      for (const row of rows) {
        if (row.parentPodiumId === null) continue
        // `conversation_identities.parent_podium_id` carries no `$type` in the
        // schema, so it arrives as a plain string where every other id on this
        // row is branded. Same re-entry the raw statement made, named.
        out.set(row.podiumId, asConversationId(row.parentPodiumId))
      }
    }
    return out
  }

  /** The native ids evidencing each of these conversations, earliest segment first. */
  nativeIdsByPodiumIds(podiumIds: readonly ConversationId[]): Map<ConversationId, string[]> {
    const out = new Map<ConversationId, string[]>()
    for (const chunk of chunks(podiumIds)) {
      const rows = this.db
        .select({
          podiumId: conversationSegments.podiumId,
          nativeId: conversationSegments.nativeId,
        })
        .from(conversationSegments)
        .where(inArray(conversationSegments.podiumId, chunk))
        .orderBy(conversationSegments.seqInConv)
        .all()
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
  pathsByNativeIds(machineId: MachineId, nativeIds: readonly string[]): Map<string, string> {
    const out = new Map<string, string>()
    for (const chunk of chunks(nativeIds)) {
      const rows = this.db
        .select({ nativeId: conversationSegments.nativeId, path: conversationSegments.path })
        .from(conversationSegments)
        .where(
          and(
            eq(conversationSegments.machineId, machineId),
            isNotNull(conversationSegments.path),
            inArray(conversationSegments.nativeId, chunk),
          ),
        )
        .all()
      for (const row of rows) if (row.path !== null) out.set(row.nativeId, row.path)
    }
    return out
  }

  segmentPath(machineId: MachineId, nativeId: string): string | undefined {
    const row = this.db
      .select({ path: conversationSegments.path })
      .from(conversationSegments)
      .where(this.segment(machineId, nativeId))
      .get()
    return row?.path ?? undefined
  }

  ensure(opts: {
    machineId: MachineId
    nativeId: string
    providerId: string
    parentPodiumId?: ConversationId
    path?: string
    sizeBytes?: number
  }): ConversationId {
    const existing = this.podiumId(opts.machineId, opts.nativeId)
    if (existing !== undefined) {
      if (opts.parentPodiumId) {
        this.db
          .update(conversationIdentities)
          .set({ parentPodiumId: opts.parentPodiumId })
          .where(
            and(
              eq(conversationIdentities.podiumId, existing),
              isNull(conversationIdentities.parentPodiumId),
            ),
          )
          .run()
      }
      if (opts.path || opts.sizeBytes !== undefined) {
        const path = opts.path ?? null
        const reportedBytes = opts.sizeBytes ?? null
        // The trailing predicate is what keeps a re-discovery of an UNCHANGED
        // segment free. Every sweep re-offers the whole corpus, so this matched
        // its row and rewrote the same two values ~1656 times per 4 minutes on
        // the live server (2026-08-12, POD-1931). Comparing with `IS NOT`
        // against the value the SET would assign makes the no-op write vanish
        // while a real change still lands.
        this.db
          .update(conversationSegments)
          .set({
            path: sql`COALESCE(${path}, ${conversationSegments.path})`,
            reportedBytes: sql`COALESCE(${reportedBytes}, ${conversationSegments.reportedBytes})`,
          })
          .where(
            and(
              this.segment(opts.machineId, opts.nativeId),
              sql`(${conversationSegments.path} IS NOT COALESCE(${path}, ${conversationSegments.path})
                   OR ${conversationSegments.reportedBytes} IS NOT COALESCE(${reportedBytes}, ${conversationSegments.reportedBytes}))`,
            ),
          )
          .run()
      }
      return existing
    }
    const podiumId = asConversationId(`conv_${randomUUID()}`)
    const now = new Date().toISOString()
    this.db
      .insert(conversationIdentities)
      .values({ podiumId, parentPodiumId: opts.parentPodiumId ?? null, createdAt: now })
      .run()
    this.db
      .insert(conversationSegments)
      .values({
        machineId: opts.machineId,
        nativeId: opts.nativeId,
        providerId: opts.providerId,
        podiumId,
        path: opts.path ?? null,
        reportedBytes: opts.sizeBytes ?? null,
        seqInConv: 1,
        linkedBy: 'discovery',
        createdAt: now,
      })
      .run()
    return podiumId
  }

  linkSegment(opts: {
    machineId: MachineId
    newNativeId: string
    priorNativeId: string
    providerId: string
  }): ConversationId {
    const already = this.podiumId(opts.machineId, opts.newNativeId)
    if (already !== undefined) return already
    const podiumId = this.ensure({
      machineId: opts.machineId,
      nativeId: opts.priorNativeId,
      providerId: opts.providerId,
    })
    const highest = this.db
      .select({ m: max(conversationSegments.seqInConv) })
      .from(conversationSegments)
      .where(eq(conversationSegments.podiumId, podiumId))
      .get()
    const nextSeq = (highest?.m ?? 0) + 1
    this.db
      .insert(conversationSegments)
      .values({
        machineId: opts.machineId,
        nativeId: opts.newNativeId,
        providerId: opts.providerId,
        podiumId,
        path: null,
        seqInConv: nextSeq,
        linkedBy: 'live-roll',
        createdAt: new Date().toISOString(),
      })
      .run()
    return podiumId
  }

  podiumIds(machineId: MachineId, nativeIds: string[]): Map<string, ConversationId> {
    const out = new Map<string, ConversationId>()
    // ONE STATEMENT PER NATIVE ID, exactly as before. Batching this is a
    // behaviour question rather than a rewrite — the caller's map is keyed by
    // the ids it asked for and a missing row must stay missing — so it is left
    // for the read-scope work (B0.6) rather than decided in a conversion.
    for (const nativeId of nativeIds) {
      const row = this.db
        .select({ podiumId: conversationSegments.podiumId })
        .from(conversationSegments)
        .where(this.segment(machineId, nativeId))
        .get()
      if (row) out.set(nativeId, row.podiumId)
    }
    return out
  }

  siblingSegments(
    machineId: MachineId,
    nativeId: string,
  ): { machineId: MachineId; nativeId: string }[] {
    const podiumId = this.podiumId(machineId, nativeId)
    if (!podiumId) return []
    return this.db
      .select({
        machineId: conversationSegments.machineId,
        nativeId: conversationSegments.nativeId,
      })
      .from(conversationSegments)
      .where(eq(conversationSegments.podiumId, podiumId))
      .orderBy(conversationSegments.seqInConv)
      .all()
  }

  private segment(machineId: MachineId, nativeId: string) {
    return and(
      eq(conversationSegments.machineId, machineId),
      eq(conversationSegments.nativeId, nativeId),
    )
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
