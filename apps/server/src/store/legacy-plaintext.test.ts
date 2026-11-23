/**
 * The keys stored in plain text before the vault are destroyed once moved
 * (credential management design §7, "Old plaintext is destroyed"; plan Task 21).
 *
 * Every test plants obviously fake old values into a database as a version
 * before the vault left it, starts the server's store on it, and reads the raw
 * rows and the bytes of the database file and its sidecars.
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSink, createRingBufferSink } from '@podium/logger'
import { asUserId, firstAdminMemberId, primeFirstAdminMember, type UserId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { measureCompactionSpace } from '../migrations/legacy-compaction-space'
import { scrubLegacySnapshots } from '../migrations/legacy-snapshot-scrub'
import { credentialIdFromLegacy } from '../modules/credentials/legacy-ids'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { SessionStore } from '../store'
import { memberFacts } from './fixtures/test-support'
import { LEGACY_PLAINTEXT_STATE_KEY, type LegacyPlaintextOptions } from './legacy-plaintext'
import {
  defaultLegacyPlaintextJobRunner,
  executeLegacyPlaintextJob,
  type LegacyPlaintextJobRunner,
  withProgressHeartbeat,
} from './legacy-plaintext-jobs'

/** Obviously fake old values, one per place a key was kept before the vault. */
const ACCOUNT_KEY = 'FAKE-sk-ant-destroy-account-0001'
const CLAUDE_TOKEN = 'FAKE-sk-ant-oat01-destroy-token-0002'
const API_KEYS = {
  'apiKeys.anthropic': 'FAKE-sk-ant-destroy-workspace-0003',
  'apiKeys.openai': 'FAKE-sk-openai-destroy-workspace-0004',
  'apiKeys.openrouter': 'FAKE-sk-or-destroy-workspace-0005',
} as const
const LINEAR = 'FAKE-lin_api_destroy_0006'
const TELEGRAM = 'FAKE-123456:telegram-destroy-0007'
/** A login file as an old propagation parked it (`PortableCredentialBundle`). */
const LOGIN_FILE_BASE64 = Buffer.from(
  JSON.stringify({ tokens: { refresh_token: 'FAKE-refresh-destroy-login-file-0008' } }),
).toString('base64')
const BUNDLE = JSON.stringify({ kind: 'codex', contentBase64: LOGIN_FILE_BASE64 })
const MEMBER = asUserId('user:destroy-member')
const MEMBER_KEY = 'FAKE-sk-openai-destroy-member-0009'
const READER = asUserId('user:destroy-reader')
/** A login file an old version deleted without secure_delete: its bytes sit in free pages. */
const FREED = 'FAKE-refresh-freed-page-0013'

/** Every planted value, as the bytes a search looks for. */
const PLANTED = [
  ACCOUNT_KEY,
  CLAUDE_TOKEN,
  ...Object.values(API_KEYS),
  LINEAR,
  TELEGRAM,
  LOGIN_FILE_BASE64,
  FREED,
]

/** The step's report at a start where it ran. */
function ran(store: SessionStore) {
  const report = store.legacyPlaintextReport
  if (!report?.ran) throw new Error('the step did not run at this start')
  return report
}

function place() {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-plaintext-'))
  return { dir, dbPath: join(dir, 'podium.db'), keyPath: join(dir, 'config', 'vault.key') }
}

/** The database file and its sidecars, as bytes, for the files that exist. */
function databaseBytes(dbPath: string): Buffer {
  return Buffer.concat(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path)),
  )
}

const heldIn = (bytes: Buffer): string[] =>
  PLANTED.filter((value) => bytes.includes(Buffer.from(value, 'utf8')))

function sql<T>(dbPath: string, run: (db: SqlDatabase) => T): T {
  const db = openDatabase(dbPath)
  try {
    return run(db)
  } finally {
    db.close()
  }
}

const accountRows = (dbPath: string) =>
  sql(dbPath, (db) => db.prepare('SELECT id, credential FROM accounts ORDER BY id').all()) as {
    id: string
    credential: string
  }[]

const stateOf = (dbPath: string) =>
  sql(dbPath, (db) =>
    db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_PLAINTEXT_STATE_KEY),
  )

/** A runner whose scrub finds no room for a copy, as the dev.38 host's disk did. */
const noRoomToScrub: LegacyPlaintextJobRunner = async (job) =>
  job.kind === 'scrub'
    ? {
        kind: 'scrub',
        results: scrubLegacySnapshots(job.dbPath, { ...job, freeBytes: () => 0 }),
      }
    : executeLegacyPlaintextJob(job)

const secretKeys = (dbPath: string) =>
  (
    sql(dbPath, (db) => db.prepare('SELECT key FROM workspace_secrets ORDER BY key').all()) as {
      key: string
    }[]
  ).map((r) => r.key)

describe('the old plaintext keys after the move into the vault', () => {
  const open: SessionStore[] = []

  afterEach(async () => {
    for (const store of open.splice(0)) await store.close()
  })

  async function openAt(
    dbPath: string,
    keyPath: string,
    legacyPlaintext?: LegacyPlaintextOptions,
  ): Promise<SessionStore> {
    const store = await SessionStore.open(dbPath, undefined, {
      vaultKeyFile: keyPath,
      changeCapture: 'whenLogAttaches',
      ...(legacyPlaintext ? { legacyPlaintext } : {}),
    })
    primeFirstAdminMember(await firstAdminMemberId(store))
    open.push(store)
    return store
  }

  async function close(store: SessionStore): Promise<void> {
    open.splice(open.indexOf(store), 1)
    await store.close()
  }

  /**
   * A database as a version before the vault left it: an API-key row and a
   * Claude-token row of the first admin, a member's key, the three `apiKeys.*`
   * secrets, the Linear key and Telegram token in plain text, and a native
   * login transfer row. The schema is made by a first start; the rows are
   * written raw, and the step's state row is removed, as before this release.
   */
  async function plantOldDatabase(
    dbPath: string,
    keyPath: string,
    { transferRow = true } = {},
  ): Promise<UserId> {
    const store = await openAt(dbPath, keyPath)
    const admin = await firstAdminMemberId(store)
    await memberFacts(store).create(
      {
        id: MEMBER,
        displayName: 'Member',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      await hashPassword('member-password'),
    )
    await close(store)
    sql(dbPath, (db) => {
      const account = db.prepare(
        `INSERT INTO accounts (workspace_id, id, provider, kind, credential, identity, scope, created_at,
           owner_user_id, account_key, ref, shared_with)
         VALUES ('${SELF_HOSTED_WORKSPACE_ID}', ?, ?, ?, ?, '', 'role', ?, ?, ?, NULL, NULL)`,
      )
      account.run(
        `managed:anthropic@${admin}`,
        'anthropic',
        'api-key',
        ACCOUNT_KEY,
        1_000,
        admin,
        'managed:anthropic',
      )
      account.run(
        `managed:claude-oauth@${admin}`,
        'anthropic',
        'oauth',
        CLAUDE_TOKEN,
        2_000,
        admin,
        'managed:claude-oauth',
      )
      account.run(
        `managed:openai@${MEMBER}`,
        'openai',
        'api-key',
        MEMBER_KEY,
        3_000,
        MEMBER,
        'managed:openai',
      )
      db.prepare(
        `INSERT INTO account_machine_sends (workspace_id, account_id, machine_id, sent_at) VALUES ('${SELF_HOSTED_WORKSPACE_ID}', ?, 'm-sent', '2026-11-01T00:00:00Z')`,
      ).run(`managed:openai@${MEMBER}`)
      const secret = db.prepare(
        `INSERT OR REPLACE INTO workspace_secrets (workspace_id, key, value, updated_at) VALUES ('${SELF_HOSTED_WORKSPACE_ID}', ?, ?, ?)`,
      )
      for (const [key, value] of Object.entries(API_KEYS))
        secret.run(key, value, '2026-01-01T00:00:00.000Z')
      secret.run('integrations.linearApiKey', LINEAR, '2026-01-01T00:00:00.000Z')
      secret.run('notifications.telegramBotToken', TELEGRAM, '2026-01-01T00:00:00.000Z')
      db.exec('PRAGMA secure_delete = OFF')
      secret.run(
        'native-login-transfer:freed',
        `${FREED}${'x'.repeat(9_000)}`,
        '2026-01-01T00:00:00.000Z',
      )
      db.prepare("DELETE FROM workspace_secrets WHERE key = 'native-login-transfer:freed'").run()
      // The transfer sweep's own truncate waits out a reader; the busy tests leave it out.
      if (transferRow) {
        secret.run(`native-login-transfer:${randomUUID()}`, BUNDLE, '2026-01-01T00:00:00.000Z')
      }
      db.prepare('DELETE FROM meta WHERE key = ?').run(LEGACY_PLAINTEXT_STATE_KEY)
    })
    return admin
  }

  it('after the step podium.db and its sidecars hold none of the planted values', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath)
    // The canary: the search finds every planted value before the step.
    expect(heldIn(databaseBytes(dbPath))).toEqual(PLANTED)

    const store = await openAt(dbPath, keyPath)
    expect(store.legacyPlaintextReport).toMatchObject({
      ran: true,
      compaction: 'clean',
      leftInPlace: [],
    })
    expect(heldIn(databaseBytes(dbPath))).toEqual([])
    await close(store)
    expect(heldIn(databaseBytes(dbPath))).toEqual([])
    // The accounts table is emptied and stays; the old secrets are gone.
    expect(accountRows(dbPath)).toEqual([])
    expect(secretKeys(dbPath).filter((key) => key.startsWith('apiKeys.'))).toEqual([])
    expect(
      sql(dbPath, (db) => db.prepare('SELECT count(*) AS n FROM account_machine_sends').get()),
    ).toEqual({ n: 0 })
  })

  it('the step removes the planted values from the retained snapshots too', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath)
    // The snapshot a migration took before this release's schema change.
    const snapshot = `${dbPath}.backup-vdrizzle-40-2026-11-01T00-00-00-000Z`
    copyFileSync(dbPath, snapshot)
    if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${snapshot}-wal`)
    expect(heldIn(databaseBytes(snapshot))).toEqual(PLANTED)

    const store = await openAt(dbPath, keyPath)
    // The boot leaves the snapshot to the scrub after start (POD-7252).
    expect(store.legacyPlaintextReport).toMatchObject({ ran: true, snapshotsToScrub: [snapshot] })
    expect(heldIn(databaseBytes(snapshot))).toEqual(PLANTED)
    expect(stateOf(dbPath)).toEqual({ value: 'compacted' })

    expect(await store.scrubLegacySnapshots()).toEqual({
      ran: true,
      scrubbed: 1,
      problems: [],
      givenUp: [],
    })
    expect(heldIn(databaseBytes(snapshot))).toEqual([])
    expect(sql(snapshot, (db) => db.prepare('PRAGMA integrity_check').all())).toEqual([
      { integrity_check: 'ok' },
    ])
    expect(stateOf(dbPath)).toEqual({ value: 'done' })
  })

  it('compacts a large file on a worker thread, reporting progress while it runs (POD-7252)', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath)
    const stages: string[] = []
    const worker = defaultLegacyPlaintextJobRunner(0)
    const store = await openAt(dbPath, keyPath, {
      // The real worker, held a little so the heartbeat is seen.
      runJob: async (job, bytes, signal) => {
        const result = await worker(job, bytes, signal)
        await new Promise((resolve) => setTimeout(resolve, 60))
        return result
      },
      progress: { report: (stage) => stages.push(stage), everyMs: 20 },
    })
    expect(ran(store).compaction).toBe('clean')
    expect(heldIn(databaseBytes(dbPath))).toEqual([])
    expect(stages[0]).toBe('vault: compacting the database')
    expect(stages.length).toBeGreaterThan(1)
    // Every step has a name of its own: the supervisor counts only new ones.
    expect(new Set(stages).size).toBe(stages.length)
  })

  it('does not compact without room on disk, and the next start with room does (POD-7252)', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath)
    const first = await openAt(dbPath, keyPath, { freeBytes: () => 0 })
    expect(ran(first).compaction).toBe('no-space')
    await close(first)
    expect(stateOf(dbPath)).toEqual({ value: 'compaction-pending' })
    // The rows are gone; a value an old version freed is still in a free page.
    expect(accountRows(dbPath)).toEqual([])
    expect(heldIn(databaseBytes(dbPath))).toContain(FREED)

    const second = await openAt(dbPath, keyPath)
    expect(second.legacyPlaintextReport).toMatchObject({ ran: true, compaction: 'clean' })
    expect(heldIn(databaseBytes(dbPath))).toEqual([])
    expect(stateOf(dbPath)).toEqual({ value: 'done' })
  })

  it('a snapshot without room to scrub is tried a bounded number of times (POD-7252)', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath)
    const snapshot = `${dbPath}.backup-vdrizzle-40-2026-11-01T00-00-00-000Z`
    copyFileSync(dbPath, snapshot)
    if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${snapshot}-wal`)

    const reports = []
    for (let start = 0; start < 3; start += 1) {
      const store = await openAt(dbPath, keyPath, { runJob: noRoomToScrub })
      expect(ran(store).snapshotsToScrub).toEqual([snapshot])
      reports.push(await store.scrubLegacySnapshots())
      await close(store)
    }
    expect(reports.map((report) => report.ran && report.problems.length)).toEqual([1, 1, 1])
    expect(reports.map((report) => report.ran && report.givenUp)).toEqual([[], [], [snapshot]])

    // Given up: the start finds nothing to scrub, and the step is not finished.
    const fourth = await openAt(dbPath, keyPath, { runJob: noRoomToScrub })
    expect(ran(fourth).snapshotsToScrub).toEqual([])
    expect(await fourth.scrubLegacySnapshots()).toEqual({ ran: false })
    await close(fourth)
    expect(stateOf(dbPath)).toEqual({ value: 'compacted' })
    expect(heldIn(databaseBytes(snapshot))).toEqual(PLANTED)

    // Once retention prunes it, the step finishes.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${snapshot}${suffix}`, { force: true })
    const fifth = await openAt(dbPath, keyPath)
    expect(ran(fifth).snapshotsToScrub).toEqual([])
    await close(fifth)
    expect(stateOf(dbPath)).toEqual({ value: 'done' })
  })

  it('a snapshot taken after the compaction is a copy of the clean file and is not scrubbed (POD-7252)', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath)
    // A snapshot the scrub cannot finish keeps the step open across starts.
    const stuck = `${dbPath}.backup-vdrizzle-40-2026-11-01T00-00-00-000Z`
    copyFileSync(dbPath, stuck)
    const first = await openAt(dbPath, keyPath, { runJob: noRoomToScrub })
    await first.scrubLegacySnapshots()
    await close(first)
    // The next update's backup: a copy of the compacted file, made after it.
    const later = `${dbPath}.backup-vdrizzle-41-2026-11-02T00-00-00-000Z`
    copyFileSync(dbPath, later)
    const second = await openAt(dbPath, keyPath, { runJob: noRoomToScrub })
    expect(ran(second).snapshotsToScrub).toEqual([stuck])
  })

  it('measures the room a compaction needs: the copy and the WAL, on one disk twice', () => {
    const { dbPath } = place()
    sql(dbPath, (db) => db.exec('CREATE TABLE t (v BLOB); INSERT INTO t VALUES (zeroblob(100000))'))
    const sameDisk = measureCompactionSpace(dbPath, () => Number.MAX_SAFE_INTEGER, tmpdir())
    expect(sameDisk.ok).toBe(true)
    const tight = measureCompactionSpace(dbPath, () => 1024, tmpdir())
    expect(tight.ok).toBe(false)
    expect(tight.detail).toMatch(/^need ~\d+ bytes free in /)
  })

  it('a heartbeat names each step anew, and stops with the work', async () => {
    const stages: string[] = []
    await withProgressHeartbeat(
      'step',
      async () => await new Promise((resolve) => setTimeout(resolve, 55)),
      (stage) => stages.push(stage),
      10,
    )
    const seen = stages.length
    expect(stages.slice(0, 3)).toEqual(['step', 'step, 0.01 s', 'step, 0.02 s'])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stages.length).toBe(seen)
  })

  it('every moved key still opens from the vault after the step', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantOldDatabase(dbPath, keyPath)
    const store = await openAt(dbPath, keyPath)
    const opened: string[] = []
    for (const owner of [admin, MEMBER]) {
      for (const credential of await store.credentials.listVisibleTo(owner)) {
        const latest = await store.credentials.latestSecret(credential.id)
        if (!latest) continue
        opened.push(
          store.vault
            .open(
              { credentialId: credential.id, type: credential.type, version: latest.version },
              latest.sealed,
            )
            .toString('utf8'),
        )
      }
    }
    expect(opened.sort()).toEqual(
      [ACCOUNT_KEY, CLAUDE_TOKEN, MEMBER_KEY, ...Object.values(API_KEYS)].sort(),
    )
    expect(await store.secrets.get('integrations.linearApiKey')).toBe(LINEAR)
    expect(await store.secrets.get('notifications.telegramBotToken')).toBe(TELEGRAM)
  })

  it('destroys an old value only after its credential opens to the same value', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantOldDatabase(dbPath, keyPath)
    // The import makes a credential from the admin's API-key row; its secret is
    // then replaced, at the same version, by another value, so the read-back
    // does not match.
    const before = await openAt(dbPath, keyPath, { destroy: false })
    const credential = await before.credentials.findByLegacyId(`managed:anthropic@${admin}`)
    if (!credential) throw new Error('the import made no credential')
    sql(dbPath, (db) =>
      db.prepare('DELETE FROM credential_secrets WHERE credential_id = ?').run(credential.id),
    )
    const sealed = await before.vault.seal(
      { credentialId: credential.id, type: credential.type, version: 1 },
      Buffer.from('FAKE-sk-ant-a-different-value', 'utf8'),
    )
    expect(await before.credentials.putSecret(credential.id, sealed, 0)).toBe(1)
    await close(before)

    const sink = createRingBufferSink()
    const dispose = addSink(sink)
    try {
      const store = await openAt(dbPath, keyPath)
      expect(ran(store).leftInPlace).toEqual([`managed:anthropic@${admin}`])
    } finally {
      dispose()
    }
    expect(accountRows(dbPath)).toEqual([
      { id: `managed:anthropic@${admin}`, credential: ACCOUNT_KEY },
    ])
    const lines = sink.snapshot().filter((r) => r.ns === 'server:credentials')
    const reported = lines.find((r) => JSON.stringify(r).includes(`managed:anthropic@${admin}`))
    expect(reported?.level).toBe('warn')
    expect(JSON.stringify(lines)).not.toContain(ACCOUNT_KEY)
    // Left in place means the next start tries again.
    expect(
      sql(dbPath, (db) =>
        db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_PLAINTEXT_STATE_KEY),
      ),
    ).not.toEqual({ value: 'done' })
  })

  it('leaves every old value while the vault is locked', async () => {
    const { dir, dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath)
    // A start with `keyPath` moves the keys; another key file cannot open the vault.
    await close(await openAt(dbPath, keyPath, { destroy: false }))
    const store = await openAt(dbPath, join(dir, 'config', 'another.key'))
    expect(store.vault.state()).toBe('locked')
    expect(ran(store).destroyed).toBe(0)
    await close(store)
    expect(
      accountRows(dbPath)
        .map((r) => r.credential)
        .sort(),
    ).toEqual([ACCOUNT_KEY, CLAUDE_TOKEN, MEMBER_KEY].sort())
    expect(secretKeys(dbPath).filter((key) => key.startsWith('apiKeys.'))).toHaveLength(3)
  })

  it('destroys a value whose credential its owner removed or renewed since the move', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantOldDatabase(dbPath, keyPath)
    // Move without destroying, then change both credentials as their owners could.
    const first = await openAt(dbPath, keyPath, { destroy: false })
    const [token] = (await first.credentials.listVisibleTo(admin)).filter(
      (c) => c.type === 'anthropic.claude-token',
    )
    const [memberKey] = await first.credentials.listVisibleTo(MEMBER)
    if (!token || !memberKey) throw new Error('the import made no credentials')
    await first.credentials.remove(token.id)
    const version = (await first.credentials.latestSecret(memberKey.id))?.version ?? 0
    const renewed = await first.vault.seal(
      { credentialId: memberKey.id, type: memberKey.type, version: version + 1 },
      Buffer.from('FAKE-sk-openai-renewed-0010', 'utf8'),
    )
    expect(await first.credentials.putSecret(memberKey.id, renewed, version)).toBe(version + 1)
    await close(first)

    const store = await openAt(dbPath, keyPath)
    expect(ran(store).leftInPlace).toEqual([])
    await close(store)
    expect(accountRows(dbPath)).toEqual([])
  })

  it('keeps the old shared-key order after the accounts table is emptied', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantOldDatabase(dbPath, keyPath)
    const setup = await openAt(dbPath, keyPath, { destroy: false })
    await memberFacts(setup).create(
      {
        id: READER,
        displayName: 'Reader',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      await hashPassword('reader-password'),
    )
    await close(setup)
    // Two OpenRouter keys shared with everyone: the member's row is the older.
    sql(dbPath, (db) => {
      const insert = db.prepare(
        `INSERT INTO accounts (workspace_id, id, provider, kind, credential, identity, scope, created_at,
           owner_user_id, account_key, ref, shared_with)
         VALUES ('${SELF_HOSTED_WORKSPACE_ID}', ?, 'openrouter', 'api-key', ?, '', 'role', ?, ?, 'managed:openrouter:team', NULL, '["*"]')`,
      )
      insert.run(`managed:openrouter:team@${admin}`, 'FAKE-sk-or-order-admin-0011', 9_000, admin)
      insert.run(`managed:openrouter:team@${MEMBER}`, 'FAKE-sk-or-order-member-0012', 8_000, MEMBER)
    })
    const moved = await openAt(dbPath, keyPath, { destroy: false })
    const adminKey = await moved.credentials.findByLegacyId(`managed:openrouter:team@${admin}`)
    const memberKey = await moved.credentials.findByLegacyId(`managed:openrouter:team@${MEMBER}`)
    if (!adminKey || !memberKey) throw new Error('the import made no credentials')
    await close(moved)
    // Credentials made in the other order (the old commands could): by their own
    // creation the admin's comes first.
    sql(dbPath, (db) => {
      const at = db.prepare('UPDATE credentials SET created_at = ? WHERE id = ?')
      at.run('2026-11-01T00:00:00.000Z', adminKey.id)
      at.run('2026-11-02T00:00:00.000Z', memberKey.id)
      db.prepare('DELETE FROM meta WHERE key = ?').run(LEGACY_PLAINTEXT_STATE_KEY)
    })

    const store = await openAt(dbPath, keyPath)
    expect(accountRows(dbPath)).toEqual([])
    expect(await credentialIdFromLegacy(store, 'managed:openrouter:team', READER)).toBe(
      memberKey.id,
    )
    expect((await store.credentials.get(memberKey.id))?.createdAt).toBe(
      new Date(8_000).toISOString(),
    )
  })

  it('a second start does nothing', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath)
    const first = await openAt(dbPath, keyPath)
    expect(ran(first).ran).toBe(true)
    await close(first)
    expect(
      sql(dbPath, (db) =>
        db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_PLAINTEXT_STATE_KEY),
      ),
    ).toEqual({ value: 'done' })

    const second = await openAt(dbPath, keyPath)
    expect(second.legacyPlaintextReport).toEqual({ ran: false })
  })

  it('a busy first checkpoint is retried until the WAL is truncated', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath, { transferRow: false })
    // Another connection holds a read transaction, so the truncate is busy.
    const reader = openDatabase(dbPath)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM workspace_secrets').get()
    let waits = 0
    const store = await openAt(dbPath, keyPath, {
      wait: () => {
        waits += 1
        if (waits === 1) {
          reader.exec('COMMIT')
          reader.close()
        }
      },
    })
    expect(waits).toBe(1)
    expect(ran(store).compaction).toBe('clean')
    expect(heldIn(databaseBytes(dbPath))).toEqual([])
  })

  it('a checkpoint busy at every try stays pending, and the next start finishes it', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath, { transferRow: false })
    const reader = openDatabase(dbPath)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM workspace_secrets').get()
    const first = await openAt(dbPath, keyPath, { attempts: 3, wait: () => {} })
    expect(ran(first).compaction).toBe('busy')
    reader.exec('COMMIT')
    reader.close()
    await close(first)
    expect(
      sql(dbPath, (db) =>
        db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_PLAINTEXT_STATE_KEY),
      ),
    ).toEqual({ value: 'compaction-pending' })

    const second = await openAt(dbPath, keyPath)
    expect(second.legacyPlaintextReport).toMatchObject({ ran: true, compaction: 'clean' })
    expect(heldIn(databaseBytes(dbPath))).toEqual([])
  })
})
