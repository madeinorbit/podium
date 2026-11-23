import { openDatabase } from '@podium/runtime/sqlite'
import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { syncQueriesOver, workspaceQueries } from '../store/executor/sync-drizzle'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'
import { syncServerTables } from './sync-server-tables'

const cut = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_tenant-sync-feed'))
describe('tenant feed migration', () => {
  for (const retained of [0, 3, 5])
    it(`preserves identity, generations and the high-water mark with ${retained} retained rows`, async () => {
      const db = openDatabase(':memory:')
      try {
        expect(cut).toBeGreaterThan(0)
        runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
        db.exec("INSERT INTO feed_identity VALUES (1, 'feed-existing', 'epoch-existing', 123)")
        db.exec(
          "INSERT INTO sync_kind VALUES ('issueProjection', 17) ON CONFLICT(kind) DO UPDATE SET generation = 17",
        )
        for (let i = 0; i < 5; i++)
          db.exec(
            `INSERT INTO changes(entity, entity_id, op, payload, event_time, origin_id) VALUES ('issueProjection', 'i${i}', 'upsert', '{"v":${i}}', ${i}, 'origin')`,
          )
        db.prepare('DELETE FROM changes WHERE seq <= ?').run(5 - retained)
        const before = db.prepare('SELECT * FROM changes ORDER BY seq').all() as Record<
          string,
          unknown
        >[]
        const generations = db.prepare('SELECT * FROM sync_kind ORDER BY kind').all() as Record<
          string,
          unknown
        >[]
        // The tenant migration itself keeps every generation. A later migration
        // that rewrites a synced table bumps its kinds' generations, as the
        // sync-generation audit requires, so this is read right after it.
        runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
        expect(db.prepare('SELECT * FROM sync_kind ORDER BY kind').all()).toEqual(
          generations.map((r) => ({ ...r, tenant_id: 'local' })),
        )
        runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
        expect(db.prepare('SELECT * FROM changes ORDER BY seq').all()).toEqual(
          before.map((r) => ({ ...r, workspace_id: 'local' })),
        )
        // Credentials and Concertmaster already reload session-derived records;
        // removing draft sync reloads them a third time. Credentials also reload
        // notices, and Concertmaster initializes its new record kind.
        const bumps: Record<string, number> = {
          session: 3,
          sessionUserState: 3,
          message: 3,
          inboxNotice: 1,
          concertmasterEntry: 1,
        }
        const expected: Record<string, unknown>[] = generations.map((r) => ({
          ...r,
          workspace_id: 'local',
          generation: Number(r.generation) + (bumps[String(r.kind)] ?? 0),
        }))
        for (const [kind, generation] of Object.entries(bumps))
          if (!expected.some((r) => r.kind === kind))
            expected.push({ kind, generation, workspace_id: 'local' })
        expected.sort((x, y) => (String(x.kind) < String(y.kind) ? -1 : 1))
        expect(db.prepare('SELECT * FROM sync_kind ORDER BY kind').all()).toEqual(expected)
        const sync = new SyncRepository(
          workspaceQueries(syncQueriesOver(db), SELF_HOSTED_WORKSPACE_ID),
          syncServerTables,
          SELF_HOSTED_WORKSPACE_ID,
        )
        expect(await sync.readFeedIdentity()).toEqual({
          feedId: 'feed-existing',
          epoch: 'epoch-existing',
        })
        expect(await sync.readFeedState()).toEqual({
          headSeq: 5,
          floorSeq: retained ? 6 - retained : 6,
        })
        expect(
          await sync.appendChanges(
            [{ entity: 'issueProjection', entityId: 'next', op: 'upsert', payload: '{}' }],
            6,
          ),
        ).toEqual([6])
        runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
        expect(await sync.maxChangeSeq()).toBe(6)
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      } finally {
        db.close()
      }
    })
})
