import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'

describe('shipping recovery debt upgrade', () => {
  it('backfills held and shipped effects, repair decisions and receipts once', () => {
    const db = openDatabase(':memory:')
    try {
      // The source-only shape isolates the data migration from unrelated schema
      // evolution. Full-schema DDL and index plans run in the store audit.
      db.exec(`
        CREATE TABLE ship_orders (id TEXT PRIMARY KEY, repo_id TEXT, state TEXT, requested_at TEXT);
        CREATE TABLE ship_steps (id TEXT, order_id TEXT, kind TEXT, state TEXT, outcome TEXT, summary TEXT);
        CREATE TABLE ship_repair_candidates (order_id TEXT, attempt_id TEXT, generation INTEGER,
          context_digest TEXT, repair_ref TEXT, candidate_head_sha TEXT, result_token TEXT);
        CREATE TABLE delivery_receipts (id TEXT, order_id TEXT, destination_sha TEXT);
        INSERT INTO ship_orders VALUES ('shipped', 'repo', 'shipped', 't0'), ('held', 'repo', 'held', 't1');
        INSERT INTO ship_steps VALUES
          ('verify', 'shipped', 'verify', 'succeeded', 'proved', ''),
          ('held-validate', 'held', 'validate', 'failed', 'validation-failed', ''),
          ('running', 'held', 'validate', 'running', NULL, ''),
          ('local-refusal', 'held', 'validate', 'failed', 'authorization-refused', ''),
          ('cancel', 'held', 'cancel', 'cancelled', 'cancelled', ''),
          ('null-succeeded', 'shipped', 'verify', 'succeeded', NULL, ''),
          ('null-failed', 'held', 'validate', 'failed', NULL, ''),
          ('null-cancelled', 'held', 'publish', 'cancelled', NULL, ''),
          ('null-local', 'held', 'cancel', 'cancelled', NULL, ''),
          ('broken-marker', 'held', 'validate', 'failed', 'proved', 'shipping-repair:v2:broken');
        INSERT INTO ship_repair_candidates VALUES
          ('shipped', 'attempt', 1, 'digest', 'refs/repair', 'candidate', 'patched-token');
        INSERT INTO delivery_receipts VALUES ('receipt', 'shipped', 'landed');
      `)
      const acknowledgement = {
        resultToken: 'decision-token',
        orderId: 'held',
        attemptId: 'held-attempt',
        generation: 2,
        contextDigest: 'held-digest',
      }
      db.prepare('INSERT INTO ship_steps VALUES (?, ?, ?, ?, ?, ?)').run(
        'decision',
        'held',
        'validate',
        'failed',
        'validation-failed',
        `shipping-repair:v2:${JSON.stringify({ decision: { kind: 'needs-decision' }, acknowledgement })}`,
      )
      const migration = DRIZZLE_MIGRATIONS.find((m) => m.name.endsWith('_shipping-recovery-debt'))
      expect(migration).toBeDefined()
      db.exec(migration!.sql)
      const rows = db
        .prepare('SELECT key, kind, order_id, payload FROM ship_recovery_work ORDER BY key')
        .all() as {
        key: string
        kind: string
        order_id: string
        payload: string
      }[]
      expect(rows.filter((row) => row.kind === 'daemon-ack').map((row) => row.key)).toEqual([
        'legacy-daemon:broken-marker',
        'legacy-daemon:decision',
        'legacy-daemon:held-validate',
        'legacy-daemon:null-cancelled',
        'legacy-daemon:null-failed',
        'legacy-daemon:null-succeeded',
        'legacy-daemon:verify',
      ])
      expect(
        rows.filter((row) => row.kind === 'repair-ack').map((row) => JSON.parse(row.payload)),
      ).toEqual([
        acknowledgement,
        {
          resultToken: 'patched-token',
          orderId: 'shipped',
          attemptId: 'attempt',
          generation: 1,
          contextDigest: 'digest',
          candidate: { repairRef: 'refs/repair', candidateHeadSha: 'candidate' },
        },
      ])
      expect(rows.filter((row) => row.kind === 'descendants')).toEqual([
        {
          key: 'descendants:receipt',
          kind: 'descendants',
          order_id: 'shipped',
          payload: '{"destinationSha":"landed"}',
        },
      ])
      db.exec('DELETE FROM ship_recovery_work')
      expect(db.prepare('SELECT COUNT(*) AS n FROM ship_steps').get()).toEqual({ n: 11 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM ship_repair_candidates').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })
})
