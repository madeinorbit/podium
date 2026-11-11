/** Run only on the server-data bench VM. Measures the real startup migration
 * at the retention cap, including its pre-migration backup and schema repairs.
 * bun --conditions=@podium/source scripts/server-data-bench/tenant-migration.ts */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { DRIZZLE_MIGRATIONS } from '../../apps/server/src/migrations/drizzle-manifest.generated'
import { runDrizzleMigrations } from '../../apps/server/src/migrations/index'

const root = mkdtempSync(join(tmpdir(), 'tenant-migration-bench-'))
const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_tenant-sync-feed'))
if (cut < 0) throw new Error('tenant migration missing')
const rows = 500_000
const payload = JSON.stringify({ text: 'x'.repeat(776) })
const source = join(root, 'before.db')
try {
  const db = openDatabase(source)
  try {
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
    db.exec("INSERT INTO feed_identity VALUES (1, 'bench-feed', 'bench-epoch', 1)")
    const insert = db.prepare(
      "INSERT INTO changes(entity,entity_id,op,payload,event_time) VALUES ('session',?,'upsert',?,1)",
    )
    db.exec('BEGIN IMMEDIATE')
    for (let i = 0; i < rows; i++) insert.run(`session-${i % 1000}`, payload)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  const results = []
  for (let round = 1; round <= 3; round++) {
    const roundRoot = join(root, `round-${round}`)
    mkdirSync(roundRoot)
    const path = join(roundRoot, 'podium.db')
    copyFileSync(source, path)
    const candidate = openDatabase(path)
    try {
      const started = performance.now()
      const applied = runDrizzleMigrations(candidate, DRIZZLE_MIGRATIONS, { dbPath: path })
      const wallMs = performance.now() - started
      const feed = candidate
        .prepare(
          "SELECT head_seq, floor_seq, feed_id, epoch FROM sync_feed WHERE tenant_id = 'local'",
        )
        .get() as { head_seq: number; floor_seq: number; feed_id: string; epoch: string }
      const retained = candidate
        .prepare(
          "SELECT count(*) AS n, sum(length(payload)) AS payload_bytes FROM changes WHERE tenant_id = 'local'",
        )
        .get() as { n: number; payload_bytes: number }
      if (
        retained.n !== rows ||
        feed.head_seq !== rows ||
        feed.floor_seq !== 1 ||
        feed.epoch !== 'bench-epoch'
      )
        throw new Error('migration changed the fixture')
      if (candidate.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('foreign key violation')
      results.push({ round, wallMs, applied, ...feed, ...retained })
    } finally {
      candidate.close()
      rmSync(roundRoot, { recursive: true, force: true })
    }
  }
  process.stdout.write(
    JSON.stringify({ rows, payloadBytesPerRow: payload.length, results }, null, 2) + '\n',
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
