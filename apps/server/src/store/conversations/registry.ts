import { randomUUID } from 'node:crypto'
import { asConversationId, type ConversationId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'

/** Stable Podium identities and the machine-native artifacts that evidence them. */
export class ConversationRegistryRepository {
  constructor(private readonly db: SqlDatabase) {}

  repairSubagentSegmentPaths(): void {
    this.db.exec(
      "UPDATE conversation_segments SET path=NULL WHERE path LIKE '%/subagents/%' AND path NOT LIKE '%/' || native_id || '.jsonl'",
    )
  }

  podiumId(machineId: string, nativeId: string): ConversationId | undefined {
    const row = this.db
      .prepare('SELECT podium_id FROM conversation_segments WHERE machine_id=? AND native_id=?')
      .get(machineId, nativeId) as { podium_id: ConversationId } | undefined
    return row?.podium_id
  }

  segmentPath(machineId: string, nativeId: string): string | undefined {
    const row = this.db
      .prepare('SELECT path FROM conversation_segments WHERE machine_id=? AND native_id=?')
      .get(machineId, nativeId) as { path: string | null } | undefined
    return row?.path ?? undefined
  }

  ensure(opts: {
    machineId: string
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
        this.db
          .prepare(
            'UPDATE conversation_segments SET path=COALESCE(?,path), reported_bytes=COALESCE(?,reported_bytes) WHERE machine_id=? AND native_id=?',
          )
          .run(opts.path ?? null, opts.sizeBytes ?? null, opts.machineId, opts.nativeId)
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
    machineId: string
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

  podiumIds(machineId: string, nativeIds: string[]): Map<string, ConversationId> {
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

  siblingSegments(machineId: string, nativeId: string): { machineId: string; nativeId: string }[] {
    const podiumId = this.podiumId(machineId, nativeId)
    if (!podiumId) return []
    const rows = this.db
      .prepare(
        'SELECT machine_id,native_id FROM conversation_segments WHERE podium_id=? ORDER BY seq_in_conv',
      )
      .all(podiumId) as { machine_id: string; native_id: string }[]
    return rows.map((row) => ({ machineId: row.machine_id, nativeId: row.native_id }))
  }
}
