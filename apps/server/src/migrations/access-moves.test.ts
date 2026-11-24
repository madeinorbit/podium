/**
 * WHERE THE ACCESS-MOVE LOG STARTS (POD-7552).
 *
 * The log records each human's last access move from the moment it exists. A
 * device cursor from before that moment may have missed a move the log never
 * saw, and the change-log rows that would show it may be pruned. So the
 * migration writes, per feed, the row naming where recording started: its head
 * at the time. A cursor below it is answered as a rescope.
 */

import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const ACCESS_MOVES = DRIZZLE_MIGRATIONS.findIndex((m) => m.name.endsWith('_access-moves'))

describe('the access-moves migration', () => {
  it('starts every existing feed at its head, and names no human', () => {
    expect(ACCESS_MOVES).toBeGreaterThan(0)
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, ACCESS_MOVES))
    const feed = db.prepare(
      `INSERT INTO sync_feed (workspace_id, feed_id, epoch, minted_at, head_seq, floor_seq)
       VALUES (?, ?, ?, 1, ?, 1)`,
    )
    // The self-hosted feed exists already (an earlier migration provisions it).
    db.prepare("UPDATE sync_feed SET head_seq = 812 WHERE workspace_id = 'local'").run()
    feed.run('ws_other', 'feed-b', 'epoch-b', 3)

    expect(runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)).toContain(
      DRIZZLE_MIGRATIONS[ACCESS_MOVES]?.name,
    )

    expect(
      db
        .prepare('SELECT workspace_id, human_id, seq FROM sync_access_moves ORDER BY workspace_id')
        .all(),
    ).toEqual([
      { workspace_id: 'local', human_id: '', seq: 812 },
      { workspace_id: 'ws_other', human_id: '', seq: 3 },
    ])
  })

  it('starts a fresh feed at its head too: nothing a device holds predates it', () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    expect(db.prepare('SELECT workspace_id, human_id, seq FROM sync_access_moves').all()).toEqual(
      db.prepare("SELECT workspace_id, '' AS human_id, head_seq AS seq FROM sync_feed").all(),
    )
  })
})
