import { randomUUID } from 'node:crypto'
import { asConversationId, type ConversationId, type MachineId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'

/** Stable Podium identities and the machine-native artifacts that evidence them. */
export class ConversationRegistryRepository {
  constructor(private readonly db: SqlDatabase) {}

  repairSubagentSegmentPaths(): void {
    this.db.exec(
      "UPDATE conversation_segments SET path=NULL WHERE path LIKE '%/subagents/%' AND path NOT LIKE '%/' || native_id || '.jsonl'",
    )
  }

  podiumId(machineId: MachineId, nativeId: string): ConversationId | undefined {
    const row = this.db
      .prepare('SELECT podium_id FROM conversation_segments WHERE machine_id=? AND native_id=?')
      .get(machineId, nativeId) as { podium_id: ConversationId } | undefined
    return row?.podium_id
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
    paths: readonly string[],
  ): Map<string, { machineId: MachineId; nativeId: string; podiumId: ConversationId }> {
    const out = new Map<
      string,
      { machineId: MachineId; nativeId: string; podiumId: ConversationId }
    >()
    const unique = [...new Set(paths)]
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      const rows = this.db
        .prepare(
          `SELECT machine_id, native_id, podium_id, path FROM conversation_segments
           WHERE path IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as {
        machine_id: MachineId
        native_id: string
        podium_id: ConversationId
        path: string
      }[]
      for (const row of rows) {
        if (out.has(row.path)) continue
        out.set(row.path, {
          machineId: row.machine_id,
          nativeId: row.native_id,
          podiumId: row.podium_id,
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
    const unique = [...new Set(podiumIds)]
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      const rows = this.db
        .prepare(
          `SELECT podium_id, parent_podium_id FROM conversation_identities
           WHERE parent_podium_id IS NOT NULL AND podium_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as { podium_id: ConversationId; parent_podium_id: ConversationId }[]
      for (const row of rows) out.set(row.podium_id, row.parent_podium_id)
    }
    return out
  }

  /** The native ids evidencing each of these conversations, earliest segment first. */
  nativeIdsByPodiumIds(podiumIds: readonly ConversationId[]): Map<ConversationId, string[]> {
    const out = new Map<ConversationId, string[]>()
    const unique = [...new Set(podiumIds)]
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      const rows = this.db
        .prepare(
          `SELECT podium_id, native_id FROM conversation_segments
           WHERE podium_id IN (${chunk.map(() => '?').join(',')})
           ORDER BY seq_in_conv`,
        )
        .all(...chunk) as { podium_id: ConversationId; native_id: string }[]
      for (const row of rows) {
        const list = out.get(row.podium_id)
        if (list) list.push(row.native_id)
        else out.set(row.podium_id, [row.native_id])
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
    const unique = [...new Set(nativeIds)]
    const CHUNK = 500
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK)
      const rows = this.db
        .prepare(
          `SELECT native_id, path FROM conversation_segments
           WHERE machine_id = ? AND path IS NOT NULL
             AND native_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(machineId, ...chunk) as { native_id: string; path: string }[]
      for (const row of rows) out.set(row.native_id, row.path)
    }
    return out
  }

  segmentPath(machineId: MachineId, nativeId: string): string | undefined {
    const row = this.db
      .prepare('SELECT path FROM conversation_segments WHERE machine_id=? AND native_id=?')
      .get(machineId, nativeId) as { path: string | null } | undefined
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
          .prepare(
            'UPDATE conversation_identities SET parent_podium_id=? WHERE podium_id=? AND parent_podium_id IS NULL',
          )
          .run(opts.parentPodiumId, existing)
      }
      if (opts.path || opts.sizeBytes !== undefined) {
        // The trailing predicate is what keeps a re-discovery of an UNCHANGED
        // segment free. Every sweep re-offers the whole corpus, so this matched
        // its row and rewrote the same two values ~1656 times per 4 minutes on
        // the live server (2026-08-12, POD-1931). Comparing with `IS NOT`
        // against the value the SET would assign makes the no-op write vanish
        // while a real change still lands.
        this.db
          .prepare(
            `UPDATE conversation_segments SET path=COALESCE(?,path), reported_bytes=COALESCE(?,reported_bytes)
             WHERE machine_id=? AND native_id=?
               AND (path IS NOT COALESCE(?,path) OR reported_bytes IS NOT COALESCE(?,reported_bytes))`,
          )
          .run(
            opts.path ?? null,
            opts.sizeBytes ?? null,
            opts.machineId,
            opts.nativeId,
            opts.path ?? null,
            opts.sizeBytes ?? null,
          )
      }
      return existing
    }
    const podiumId = asConversationId(`conv_${randomUUID()}`)
    const now = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO conversation_identities (podium_id,parent_podium_id,created_at) VALUES(?,?,?)',
      )
      .run(podiumId, opts.parentPodiumId ?? null, now)
    this.db
      .prepare(`INSERT INTO conversation_segments
      (machine_id,native_id,provider_id,podium_id,path,reported_bytes,seq_in_conv,linked_by,created_at)
      VALUES(?,?,?,?,?,?,1,'discovery',?)`)
      .run(
        opts.machineId,
        opts.nativeId,
        opts.providerId,
        podiumId,
        opts.path ?? null,
        opts.sizeBytes ?? null,
        now,
      )
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
    const nextSeq =
      ((
        this.db
          .prepare('SELECT MAX(seq_in_conv) AS m FROM conversation_segments WHERE podium_id=?')
          .get(podiumId) as { m: number | null }
      ).m ?? 0) + 1
    this.db
      .prepare(`INSERT INTO conversation_segments
      (machine_id,native_id,provider_id,podium_id,path,seq_in_conv,linked_by,created_at)
      VALUES(?,?,?,?,NULL,?,'live-roll',?)`)
      .run(
        opts.machineId,
        opts.newNativeId,
        opts.providerId,
        podiumId,
        nextSeq,
        new Date().toISOString(),
      )
    return podiumId
  }

  podiumIds(machineId: MachineId, nativeIds: string[]): Map<string, ConversationId> {
    const out = new Map<string, ConversationId>()
    const query = this.db.prepare(
      'SELECT podium_id FROM conversation_segments WHERE machine_id=? AND native_id=?',
    )
    for (const nativeId of nativeIds) {
      const row = query.get(machineId, nativeId) as { podium_id: ConversationId } | undefined
      if (row) out.set(nativeId, row.podium_id)
    }
    return out
  }

  siblingSegments(
    machineId: MachineId,
    nativeId: string,
  ): { machineId: MachineId; nativeId: string }[] {
    const podiumId = this.podiumId(machineId, nativeId)
    if (!podiumId) return []
    const rows = this.db
      .prepare(
        'SELECT machine_id,native_id FROM conversation_segments WHERE podium_id=? ORDER BY seq_in_conv',
      )
      .all(podiumId) as { machine_id: MachineId; native_id: string }[]
    return rows.map((row) => ({ machineId: row.machine_id, nativeId: row.native_id }))
  }
}
