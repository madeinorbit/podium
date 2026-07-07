/**
 * Machines aggregate — owns the `machines` table (registered daemons and
 * their token hashes).
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { SqlDatabase } from '@podium/core/sqlite'
import type { MachineRecord } from './types'

export class MachinesRepository {
  constructor(private readonly db: SqlDatabase) {}

  upsertMachine(m: { id: string; name: string; hostname: string; tokenHash: string }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           hostname = excluded.hostname,
           token_hash = excluded.token_hash,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(m.id, m.name, m.hostname, m.tokenHash, now, now)
  }

  listMachines(): MachineRecord[] {
    return (
      this.db
        .prepare(
          'SELECT id, name, hostname, created_at, last_seen_at FROM machines ORDER BY created_at ASC',
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      hostname: r.hostname as string,
      createdAt: r.created_at as string,
      lastSeenAt: r.last_seen_at as string,
    }))
  }

  getMachine(id: string): MachineRecord | undefined {
    const r = this.db
      .prepare('SELECT id, name, hostname, created_at, last_seen_at FROM machines WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (!r) return undefined
    return {
      id: r.id as string,
      name: r.name as string,
      hostname: r.hostname as string,
      createdAt: r.created_at as string,
      lastSeenAt: r.last_seen_at as string,
    }
  }

  /** Constant-time token comparison using sha-256 hex. */
  getMachineByToken(id: string, token: string): boolean {
    const row = this.db.prepare('SELECT token_hash FROM machines WHERE id = ?').get(id) as
      | { token_hash: string }
      | undefined
    if (!row) return false
    const a = Buffer.from(createHash('sha256').update(token).digest('hex'))
    const b = Buffer.from(row.token_hash)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  renameMachine(id: string, name: string): void {
    this.db.prepare('UPDATE machines SET name = ? WHERE id = ?').run(name, id)
  }

  deleteMachine(id: string): void {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id)
  }

  touchMachine(id: string, hostname: string): void {
    this.db
      .prepare('UPDATE machines SET last_seen_at = ?, hostname = ? WHERE id = ?')
      .run(new Date().toISOString(), hostname, id)
  }
}
