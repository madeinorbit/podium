import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

it('backfills all four assignments, distinguishes supervisor-only, and never backfills live availability', () => {
  const db = openDatabase(':memory:')
  try {
    const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('machine-assignment-availability'))
    expect(cut).toBeGreaterThan(0)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
    const cases = [
      { id: 'neither', assignment: { server: false, agentExecution: false }, components: null, presence: null },
      { id: 'server', assignment: { server: true, agentExecution: false }, components: '["server"]', presence: 'supervisor' },
      { id: 'daemon', assignment: { server: false, agentExecution: true }, components: '["daemon"]', presence: 'legacy-daemon' },
      { id: 'both', assignment: { server: true, agentExecution: true }, components: '["server","daemon"]', presence: 'supervisor' },
      { id: 'legacy-paired', assignment: { server: false, agentExecution: true }, components: null, presence: null },
      { id: 'supervisor-only', assignment: { server: false, agentExecution: true }, components: null, presence: 'supervisor' },
    ]
    for (const row of cases) db.prepare(`INSERT INTO machines
      (id, name, hostname, token_hash, created_at, last_seen_at, service_assignment_json, components_json, presence_source)
      VALUES (?, ?, ?, 'hash', '2026-09-01', '2026-09-01', ?, ?, ?)`).run(
        row.id, row.id, row.id, JSON.stringify(row.assignment), row.components, row.presence)
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
    for (const row of cases) {
      const saved = db.prepare('SELECT service_assignment_json, assignment_evidence_json, availability_json FROM machines WHERE id = ?').get(row.id) as {
        service_assignment_json: string; assignment_evidence_json: string; availability_json: string | null
      }
      expect(JSON.parse(saved.service_assignment_json)).toEqual(row.id === 'supervisor-only'
        ? { server: false, agentExecution: false } : row.assignment)
      expect(JSON.parse(saved.assignment_evidence_json)).toEqual({ version: 1, source: 'migration-20260917-legacy-evidence', requestId: row.id })
      expect(saved.availability_json).toBeNull()
    }
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
  } finally { db.close() }
})
