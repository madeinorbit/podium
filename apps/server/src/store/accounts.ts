/**
 * Managed-account aggregate — credentials Podium holds and injects at spawn
 * [spec:SP-6454]. Separate from the settings blob on purpose: settings round-trip
 * to the browser wholesale, credentials must not.
 *
 * `credential` never leaves the server. Clients see only `identity` (masked),
 * via accountViews().
 */

import type { SqlDatabase } from '@podium/runtime/sqlite'

export interface ManagedAccountRow {
  id: string
  provider: string
  kind: 'api-key' | 'oauth'
  credential: string
  identity: string
  /** 'role' = selected per role (#216, the only value written today).
   *  'ambient' = injected into every spawn (#214, GitHub). */
  scope: 'role' | 'ambient'
  createdAt: number
}

interface Row {
  id: string
  provider: string
  kind: string
  credential: string
  identity: string
  scope: string
  created_at: number
}

function toRow(r: Row): ManagedAccountRow {
  return {
    id: r.id,
    provider: r.provider,
    kind: r.kind === 'oauth' ? 'oauth' : 'api-key',
    credential: r.credential,
    identity: r.identity,
    scope: r.scope === 'ambient' ? 'ambient' : 'role',
    createdAt: r.created_at,
  }
}

export class AccountsRepository {
  constructor(private readonly db: SqlDatabase) {}

  list(): ManagedAccountRow[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as Row[]
    return rows.map(toRow)
  }

  get(id: string): ManagedAccountRow | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined
    return row ? toRow(row) : undefined
  }

  upsert(row: ManagedAccountRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO accounts (id, provider, kind, credential, identity, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.provider, row.kind, row.credential, row.identity, row.scope, row.createdAt)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }
}
