/**
 * Migration 014 — machines.inventory_json (#222).
 *
 * The daemon reports a machine inventory (os/arch/podiumVersion + per-agent
 * install/version/login) after its handshake authenticates; the server persists
 * it here as a single JSON blob — simpler than 4+ typed columns, and the shape
 * will grow. Nullable: a machine whose daemon never reported stays NULL.
 * Idempotent: skips when the column already exists.
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export function up(db: SqlDatabase): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(machines)').all() as { name: string }[]).map((c) => c.name),
  )
  if (!cols.has('inventory_json')) {
    db.exec('ALTER TABLE machines ADD COLUMN inventory_json TEXT')
  }
}
