import { MaintenanceCommandReply, type MaintenanceCommandReply as Reply } from '@podium/protocol'
import type { SqlDatabase } from '@podium/runtime/sqlite'

export interface MaintenanceLeaseRow {
  name: string
  generationId: string
  fencingToken: number
  expiresAt: string
  protocolVersion: number
  schemaVersion: string
  updatedAt: string
}

function mapLease(row: Record<string, unknown>): MaintenanceLeaseRow {
  return {
    name: row.name as string,
    generationId: row.generation_id as string,
    fencingToken: row.fencing_token as number,
    expiresAt: row.expires_at as string,
    protocolVersion: row.protocol_version as number,
    schemaVersion: row.schema_version as string,
    updatedAt: row.updated_at as string,
  }
}

/** Server-owned durable fence and maintenance idempotency ledger [spec:SP-c29e]. */
export class MaintenanceRepository {
  constructor(private readonly db: SqlDatabase) {}

  getLease(name: string): MaintenanceLeaseRow | undefined {
    const row = this.db.prepare('SELECT * FROM maintenance_leases WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined
    return row ? mapLease(row) : undefined
  }

  putLease(lease: MaintenanceLeaseRow): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_leases
           (name, generation_id, fencing_token, expires_at, protocol_version, schema_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           generation_id = excluded.generation_id,
           fencing_token = excluded.fencing_token,
           expires_at = excluded.expires_at,
           protocol_version = excluded.protocol_version,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        lease.name,
        lease.generationId,
        lease.fencingToken,
        lease.expiresAt,
        lease.protocolVersion,
        lease.schemaVersion,
        lease.updatedAt,
      )
  }

  getCommand(jobKind: string, runKey: string): Reply | undefined {
    const row = this.db
      .prepare('SELECT result_json FROM maintenance_commands WHERE job_kind = ? AND run_key = ?')
      .get(jobKind, runKey) as { result_json: string } | undefined
    if (!row) return undefined
    return MaintenanceCommandReply.parse(JSON.parse(row.result_json))
  }

  recordCommand(reply: Reply, fencingToken: number, appliedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_commands
           (job_kind, run_key, fencing_token, result_json, applied_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(reply.jobKind, reply.runKey, fencingToken, JSON.stringify(reply), appliedAt)
  }
}
