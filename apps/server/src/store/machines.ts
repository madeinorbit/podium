/**
 * Machines aggregate — owns the `machines` table (registered daemons and
 * their token hashes).
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { Inventory, type MachineId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import type { MachineRecord } from './types'

/** Defensive parse of a stored inventory blob → undefined on any failure. Goes
 *  through the zod schema (not a bare cast) so schema defaults are applied — a
 *  blob persisted before `tools` existed reads back with `tools: []` (#214). */
function parseInventory(json: unknown): Inventory | undefined {
  if (typeof json !== 'string' || json.length === 0) return undefined
  try {
    const parsed = Inventory.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function toRecord(r: Record<string, unknown>): MachineRecord {
  const inventory = parseInventory(r.inventory_json)
  return {
    // SERIALIZATION EDGE: untyped from sqlite; the machine id re-enters its id space.
    id: r.id as MachineId,
    name: r.name as string,
    hostname: r.hostname as string,
    createdAt: r.created_at as string,
    lastSeenAt: r.last_seen_at as string,
    ...(inventory !== undefined ? { inventory } : {}),
    // POD-1079: no `??` fallback. A row whose column is NULL reads back as
    // unowned, and unowned refuses `use` to everyone — substituting an owner
    // here would be the fail-open shape the nullable column exists to avoid.
    ownerUserId: (r.owner_user_id as string | null | undefined) ?? null,
  }
}

export class MachinesRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Register or refresh a machine row.
   *
   * `ownerUserId` is REQUIRED at the type level (POD-1079) — every caller must
   * say who a machine belongs to, and `null` is the way to say "nobody", which
   * refuses `use` to everyone rather than admitting everyone. An optional field
   * would let a new pairing path forget, and forgetting would read as unowned
   * only by luck.
   *
   * ON CONFLICT KEEPS AN OWNER THAT ALREADY EXISTS (`COALESCE`). A returning
   * daemon's `hello`, a boot-time `ensureHostMachine` and a re-pair all run
   * through here, and none of them is an ownership TRANSFER: letting the latest
   * writer win would make re-pairing a silent take-over of somebody else's
   * machine. It fills a NULL, so a row written before this column existed
   * acquires an owner the first time its owner touches it.
   */
  upsertMachine(m: {
    id: string
    name: string
    hostname: string
    tokenHash: string
    ownerUserId: string | null
  }): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           hostname = excluded.hostname,
           token_hash = excluded.token_hash,
           last_seen_at = excluded.last_seen_at,
           owner_user_id = COALESCE(machines.owner_user_id, excluded.owner_user_id)`,
      )
      .run(m.id, m.name, m.hostname, m.tokenHash, now, now, m.ownerUserId)
  }

  listMachines(): MachineRecord[] {
    return (
      this.db
        .prepare(
          'SELECT id, name, hostname, created_at, last_seen_at, inventory_json, owner_user_id FROM machines ORDER BY created_at ASC',
        )
        .all() as Record<string, unknown>[]
    ).map(toRecord)
  }

  getMachine(id: string): MachineRecord | undefined {
    const r = this.db
      .prepare(
        'SELECT id, name, hostname, created_at, last_seen_at, inventory_json, owner_user_id FROM machines WHERE id = ?',
      )
      .get(id) as Record<string, unknown> | undefined
    if (!r) return undefined
    return toRecord(r)
  }

  /** Persist a daemon-reported inventory (#222) as the raw JSON blob. */
  setMachineInventory(id: string, inventoryJson: string): void {
    this.db.prepare('UPDATE machines SET inventory_json = ? WHERE id = ?').run(inventoryJson, id)
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

  /**
   * Force-write the owner projection (POD-1114 / D19.4d). Unlike
   * {@link upsertMachine}'s `COALESCE`, this is the path that applies a ledger
   * owner transition: the ledger append is the commit point, and this method
   * projects it onto the row. `null` is quarantine (usable by nobody).
   */
  setMachineOwner(id: string, ownerUserId: string | null): void {
    this.db.prepare('UPDATE machines SET owner_user_id = ? WHERE id = ?').run(ownerUserId, id)
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
