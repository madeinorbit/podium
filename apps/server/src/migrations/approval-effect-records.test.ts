/**
 * APPROVALS BECOME EFFECT RECORDS (POD-6674), through the real migration chain.
 *
 * Every row of `approval_requests` is copied into `effects` under its own id:
 * a pending one waits for its person (`awaiting`, no deadline), an executing
 * one is `running` (approved), and ended ones are tombstones that never enter
 * the feed. The undecided rows of the old table are marked failed, so a binary
 * rolled back past this release never offers a request the record may already
 * have run. The first boot puts the live copies on the change log.
 *
 * `PODIUM_REHEARSAL_DB` names a COPY of a real database (never a live one): the
 * last case migrates it and boots on it, as the handoff's rehearsal.
 */

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, expect, test } from 'vitest'
import { SessionRegistry } from '../relay'
import { openTestStore } from '../test-support/open-test-store'
import { DRIZZLE_MIGRATIONS } from './drizzle-manifest.generated'
import { runDrizzleMigrations } from './index'

const cut = DRIZZLE_MIGRATIONS.findIndex((migration) =>
  migration.name.includes('approval-effect-records'),
)

type Db = ReturnType<typeof openDatabase>

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const OPS = {
  update: { kind: 'update' },
  channel: { kind: 'channel', target: 'dev' },
} as const

function seed(db: Db): void {
  db.exec(
    "INSERT INTO users (id, display_name, role, created_at) VALUES ('user:owner', 'Owner', 'admin', '2026-01-01T00:00:00Z')",
  )
  const insert = db.prepare(
    `INSERT INTO approval_requests
       (id, machine_id, session_id, issue_id, op_json, status, created_at, decided_at, result_text)
     VALUES (?, 'm1', ?, ?, ?, ?, ?, ?, ?)`,
  )
  insert.run(
    'apr_pending',
    's1',
    'iss_1',
    JSON.stringify(OPS.update),
    'pending',
    '2026-11-01T10:00:00.000Z',
    null,
    null,
  )
  insert.run(
    'apr_executing',
    's1',
    null,
    JSON.stringify(OPS.channel),
    'executing',
    '2026-11-01T10:01:00.000Z',
    '2026-11-01T10:02:00.000Z',
    null,
  )
  insert.run(
    'apr_ok',
    's1',
    'iss_1',
    JSON.stringify(OPS.update),
    'succeeded',
    '2026-11-01T09:00:00.000Z',
    '2026-11-01T09:01:00.000Z',
    'updated',
  )
  insert.run(
    'apr_bad',
    's1',
    'iss_1',
    JSON.stringify(OPS.update),
    'failed',
    '2026-11-01T08:00:00.000Z',
    '2026-11-01T08:01:00.000Z',
    'exit 1',
  )
  insert.run(
    'apr_no',
    's1',
    'iss_1',
    JSON.stringify(OPS.update),
    'denied',
    '2026-11-01T07:00:00.000Z',
    '2026-11-01T07:01:00.000Z',
    'denied by the operator',
  )
}

function upgraded(): Db {
  const db = openDatabase(':memory:')
  expect(cut).toBeGreaterThan(0)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  seed(db)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut + 1))
  return db
}

const effect = (db: Db, id: string) =>
  db.prepare('SELECT * FROM effects WHERE id = ?').get(id) as Record<string, unknown> | undefined

test('each approval row becomes an effect record under its own id', () => {
  const db = upgraded()
  try {
    expect(effect(db, 'apr_pending')).toMatchObject({
      kind: 'approval',
      target_kind: 'issue',
      target_id: 'iss_1',
      status: 'pending',
      decision: 'awaiting',
      stage: 'awaiting-approval',
      deadline_at: null,
      attempts: 0,
      revision: 0,
      deleted_at: null,
    })
    expect(JSON.parse(String(effect(db, 'apr_pending')?.input_json))).toEqual({
      op: OPS.update,
      machineId: 'm1',
      sessionId: 's1',
      issueId: 'iss_1',
    })
    // No issue: the session is the target.
    expect(effect(db, 'apr_executing')).toMatchObject({
      target_kind: 'session',
      target_id: 's1',
      status: 'running',
      decision: 'approve',
      stage: 'executing',
      attempts: 1,
      started_at: Date.parse('2026-11-01T10:02:00.000Z'),
      revision: 0,
      deleted_at: null,
    })
    // Ended rows keep their outcome, off the feed.
    expect(effect(db, 'apr_ok')).toMatchObject({
      status: 'succeeded',
      decision: 'approve',
      revision: 1,
    })
    expect(JSON.parse(String(effect(db, 'apr_ok')?.result_json))).toEqual({ resultText: 'updated' })
    expect(effect(db, 'apr_bad')).toMatchObject({
      status: 'failed',
      error_code: 'failed',
      error_message: 'exit 1',
    })
    expect(effect(db, 'apr_no')).toMatchObject({ status: 'cancelled', decision: 'deny' })
    for (const id of ['apr_ok', 'apr_bad', 'apr_no']) {
      expect(effect(db, id)?.deleted_at).toEqual(expect.any(Number))
    }
    // The old table stays (expand-only); its undecided rows are marked failed.
    const old = db.prepare('SELECT id, status FROM approval_requests ORDER BY id').all()
    expect(old).toEqual([
      { id: 'apr_bad', status: 'failed' },
      { id: 'apr_executing', status: 'failed' },
      { id: 'apr_no', status: 'denied' },
      { id: 'apr_ok', status: 'succeeded' },
      { id: 'apr_pending', status: 'failed' },
    ])
  } finally {
    db.close()
  }
})

/** Seed a file database below the cut, so the store's own open migrates it. */
function seededFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'approval-effects-'))
  dirs.push(dir)
  const path = join(dir, 'podium.db')
  const db = openDatabase(path)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
  seed(db)
  db.close()
  return path
}

async function bootOn(path: string) {
  const store = await openTestStore(path)
  const registry = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    rehearseBoot: true,
  })
  return { store, registry }
}

test('the first boot puts the live copies on the change log, once', async () => {
  const { store, registry } = await bootOn(seededFile())
  try {
    const changed = async () =>
      (await store.sync.latestChangeStates())
        .filter((row) => row.entity === 'effect')
        .map((row) => row.entityId)
        .sort()
    expect(await changed()).toEqual(['apr_executing', 'apr_pending'])
    expect((await store.effects.get('apr_pending'))?.revision).toBe(1)
    // A later boot finds nothing to publish.
    expect(await registry.modules.approvals.publishCopiedRecords()).toBe(0)
    // The agent's CLI still reads its request by the old id.
    expect(await registry.modules.approvals.get({ id: 'apr_pending' })).toMatchObject({
      id: 'apr_pending',
      status: 'pending',
      op: OPS.update,
    })
    expect(await registry.modules.approvals.get({ id: 'apr_executing' })).toMatchObject({
      status: 'executing',
    })
  } finally {
    await registry.dispose()
  }
})

const rehearsal = process.env.PODIUM_REHEARSAL_DB

test.skipIf(!rehearsal)('rehearsal: migrates and boots on a copy of a real database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-rehearsal-'))
  dirs.push(dir)
  const path = join(dir, 'podium.db')
  copyFileSync(rehearsal!, path)
  const before = openDatabase(path)
  const old = before
    .prepare('SELECT status, COUNT(*) AS n FROM approval_requests GROUP BY status ORDER BY status')
    .all() as { status: string; n: number }[]
  before.close()
  const { store, registry } = await bootOn(path)
  try {
    const rows = (await store.effects.listAwaiting('approval', 500)).length
    const db = openDatabase(path)
    const copied = db
      .prepare(
        "SELECT status, decision, deleted_at IS NOT NULL AS tombstone, COUNT(*) AS n FROM effects WHERE kind = 'approval' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3",
      )
      .all()
    const unpublished = db.prepare('SELECT COUNT(*) AS n FROM effects WHERE revision = 0').get()
    db.close()
    console.log(JSON.stringify({ old, copied, awaiting: rows, unpublished }, null, 2))
    expect(old.reduce((n, row) => n + row.n, 0)).toBe(
      (copied as { n: number }[]).reduce((n, row) => n + row.n, 0),
    )
    expect(unpublished).toEqual({ n: 0 })
  } finally {
    await registry.dispose()
  }
})
