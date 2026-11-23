/**
 * The old keys leave Podium's retained upgrade snapshots (plan Task 21,
 * acceptance 3; review focus 9). Snapshots are built raw, in the shapes a
 * snapshot can have: the schema from before the vault, and an older one that
 * kept the secrets in the `meta['settings']` blob.
 */

import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import {
  planSnapshotScrub,
  SNAPSHOT_SCRUB_ATTEMPTS,
  type SnapshotFailure,
  scrubLegacySnapshots,
} from './legacy-snapshot-scrub'

/** Obviously fake old values. */
const ACCOUNT_KEY = 'FAKE-sk-ant-snapshot-account-0101'
const CLAUDE_TOKEN = 'FAKE-sk-ant-oat01-snapshot-token-0102'
const API_KEY = 'FAKE-sk-openai-snapshot-workspace-0103'
const LINEAR = 'FAKE-lin_api_snapshot_0104'
const TELEGRAM = 'FAKE-123456:telegram-snapshot-0105'
const BLOB_KEY = 'FAKE-sk-or-snapshot-blob-0106'
const BLOB_TELEGRAM = 'FAKE-654321:telegram-snapshot-blob-0107'
const LOGIN_FILE_BASE64 = Buffer.from(
  JSON.stringify({ tokens: { refresh_token: 'FAKE-refresh-snapshot-0108', pad: 'x'.repeat(400) } }),
).toString('base64')
/** A sealed value stays: the current version opens it. */
const SEALED = 'vault:v1:key-1:bm9uY2U=:Y2lwaGVydGV4dA=='

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE server_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL,
    credential TEXT NOT NULL, created_at INTEGER NOT NULL, owner_user_id TEXT);
  CREATE TABLE account_machine_sends (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    machine_id TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY (account_id, machine_id));
  CREATE INDEX accounts_owner ON accounts (owner_user_id);
  PRAGMA user_version = 7;
`

function place() {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-scrub-'))
  return { dir, dbPath: join(dir, 'podium.db') }
}

function withDb<T>(path: string, run: (db: SqlDatabase) => T): T {
  const db = openDatabase(path)
  try {
    return run(db)
  } finally {
    db.close()
  }
}

/** A snapshot of a database from before the vault, in WAL mode like the live one. */
function vaultEraSnapshot(path: string): void {
  withDb(path, (db) => {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(SCHEMA)
    const account = db.prepare(
      'INSERT INTO accounts (id, provider, kind, credential, created_at, owner_user_id) VALUES (?, ?, ?, ?, 1, ?)',
    )
    account.run('managed:anthropic@u1', 'anthropic', 'api-key', ACCOUNT_KEY, 'u1')
    account.run('managed:claude-oauth@u1', 'anthropic', 'oauth', CLAUDE_TOKEN, 'u1')
    account.run('native:claude-code', 'anthropic', 'native', '', 'u1')
    db.prepare(
      "INSERT INTO account_machine_sends VALUES ('managed:anthropic@u1', 'm1', '2026-11-01T00:00:00Z')",
    ).run()
    const secret = db.prepare("INSERT INTO server_secrets VALUES (?, ?, '2026-01-01T00:00:00Z')")
    secret.run('apiKeys.openai', API_KEY)
    secret.run('integrations.linearApiKey', LINEAR)
    secret.run('notifications.telegramBotToken', TELEGRAM)
    secret.run(
      `native-login-transfer:${randomUUID()}`,
      JSON.stringify({ kind: 'codex', contentBase64: LOGIN_FILE_BASE64 }),
    )
    secret.run('identity.signingSecret', 'not-an-old-key-kept-as-is')
    db.prepare("INSERT INTO meta VALUES ('settings', '{}')").run()
    // A snapshot is copied after a truncating checkpoint (`backupDatabase`), so its
    // WAL is empty; bun:sqlite's close does not fold it in by itself.
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
  })
}

/** A snapshot from before `server_secrets`: secrets in the settings blob. */
function blobEraSnapshot(path: string): void {
  withDb(path, (db) => {
    db.exec(
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 3;',
    )
    db.prepare("INSERT INTO meta VALUES ('settings', ?)").run(
      JSON.stringify({
        apiKeys: { anthropic: '', openai: '', openrouter: BLOB_KEY },
        notifications: { telegramBotToken: BLOB_TELEGRAM, telegramChatId: '42' },
        theme: 'dark',
      }),
    )
  })
}

const PLANTED = [
  ACCOUNT_KEY,
  CLAUDE_TOKEN,
  API_KEY,
  LINEAR,
  TELEGRAM,
  BLOB_KEY,
  BLOB_TELEGRAM,
  LOGIN_FILE_BASE64.slice(0, 48),
]

const fileBytes = (path: string): Buffer =>
  Buffer.concat(
    [path, `${path}-wal`, `${path}-shm`].filter((p) => existsSync(p)).map((p) => readFileSync(p)),
  )
const heldIn = (bytes: Buffer): string[] =>
  PLANTED.filter((value) => bytes.includes(Buffer.from(value, 'utf8')))

const schemaOf = (path: string): unknown =>
  withDb(path, (db) => ({
    objects: db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all(),
    version: db.prepare('PRAGMA user_version').get(),
  }))
const integrity = (path: string): unknown =>
  withDb(path, (db) => db.prepare('PRAGMA integrity_check').all())

describe('scrubbing the old keys out of retained snapshots', () => {
  it('no retained snapshot holds a planted value; each passes the integrity check and keeps its schema', () => {
    const { dbPath } = place()
    const vaultEra = `${dbPath}.backup-vdrizzle-40-2026-11-01T00-00-00-000Z`
    const blobEra = `${dbPath}.backup-vupdate-0.1.0-to-0.2.0-2026-07-01T00-00-00-000Z`
    vaultEraSnapshot(vaultEra)
    blobEraSnapshot(blobEra)
    const schemas = [schemaOf(vaultEra), schemaOf(blobEra)]
    // The canary: the search finds every planted value first.
    expect(heldIn(Buffer.concat([fileBytes(vaultEra), fileBytes(blobEra)]))).toEqual(PLANTED)

    const results = scrubLegacySnapshots(dbPath)
    expect(results.map((r) => r.outcome)).toEqual(['scrubbed', 'scrubbed'])
    for (const path of [vaultEra, blobEra]) {
      expect(heldIn(fileBytes(path))).toEqual([])
      expect(integrity(path)).toEqual([{ integrity_check: 'ok' }])
    }
    expect([schemaOf(vaultEra), schemaOf(blobEra)]).toEqual(schemas)
    // What is not an old key stays: a row without a value, a sealed value, other secrets.
    expect(
      withDb(vaultEra, (db) => ({
        accounts: db.prepare('SELECT id FROM accounts').all(),
        secrets: db.prepare('SELECT key FROM server_secrets ORDER BY key').all(),
      })),
    ).toEqual({
      accounts: [{ id: 'native:claude-code' }],
      secrets: [{ key: 'identity.signingSecret' }],
    })
    expect(
      JSON.parse(
        withDb(
          blobEra,
          (db) =>
            (db.prepare("SELECT value FROM meta WHERE key = 'settings'").get() as { value: string })
              .value,
        ),
      ),
    ).toEqual({
      apiKeys: { anthropic: '', openai: '', openrouter: '' },
      notifications: { telegramBotToken: '', telegramChatId: '42' },
      theme: 'dark',
    })
  })

  it('keeps a sealed Linear key and Telegram token', () => {
    const { dbPath } = place()
    const snapshot = `${dbPath}.backup-vdrizzle-41-2026-11-02T00-00-00-000Z`
    vaultEraSnapshot(snapshot)
    withDb(snapshot, (db) =>
      db
        .prepare("UPDATE server_secrets SET value = ? WHERE key = 'integrations.linearApiKey'")
        .run(SEALED),
    )
    scrubLegacySnapshots(dbPath)
    expect(
      withDb(snapshot, (db) =>
        db
          .prepare("SELECT value FROM server_secrets WHERE key = 'integrations.linearApiKey'")
          .get(),
      ),
    ).toEqual({ value: SEALED })
  })

  it('folds a snapshot WAL that holds frames, and scrubs what it held', () => {
    const { dir, dbPath } = place()
    const live = join(dir, 'source.db')
    vaultEraSnapshot(live)
    const snapshot = `${dbPath}.backup-vdrizzle-42-2026-11-03T00-00-00-000Z`
    // Copy the main file and a WAL holding committed frames, as a copy made mid-write would.
    const writer = openDatabase(live)
    writer.exec('PRAGMA wal_autocheckpoint = 0')
    writer
      .prepare("INSERT INTO server_secrets VALUES ('apiKeys.anthropic', ?, 'now')")
      .run('FAKE-sk-ant-snapshot-in-wal-0109')
    copyFileSync(live, snapshot)
    copyFileSync(`${live}-wal`, `${snapshot}-wal`)
    writer.close()
    expect(statSync(`${snapshot}-wal`).size).toBeGreaterThan(0)
    expect(fileBytes(snapshot).includes(Buffer.from('FAKE-sk-ant-snapshot-in-wal-0109'))).toBe(true)

    expect(scrubLegacySnapshots(dbPath).map((r) => r.outcome)).toEqual(['scrubbed'])
    expect(existsSync(`${snapshot}-wal`)).toBe(false)
    expect(fileBytes(snapshot).includes(Buffer.from('FAKE-sk-ant-snapshot-in-wal-0109'))).toBe(
      false,
    )
    expect(integrity(snapshot)).toEqual([{ integrity_check: 'ok' }])
  })

  it('a crash before the rename leaves the old file intact, and the next run finishes', () => {
    const { dir, dbPath } = place()
    const snapshot = `${dbPath}.backup-vdrizzle-43-2026-11-04T00-00-00-000Z`
    vaultEraSnapshot(snapshot)
    const before = readFileSync(snapshot)
    // A temporary copy a real crash would have left behind.
    writeFileSync(join(dir, `.podium.db.scrub-${randomUUID()}`), 'left by a crash')

    const crashed = scrubLegacySnapshots(dbPath, {
      beforeReplace: () => {
        throw new Error('crash')
      },
    })
    expect(crashed.map((r) => r.outcome)).toEqual(['failed'])
    expect(readFileSync(snapshot).equals(before)).toBe(true)
    expect(integrity(snapshot)).toEqual([{ integrity_check: 'ok' }])
    expect(readdirSync(dir).filter((name) => name.includes('.scrub-'))).toEqual([])

    expect(scrubLegacySnapshots(dbPath).map((r) => r.outcome)).toEqual(['scrubbed'])
    expect(heldIn(fileBytes(snapshot))).toEqual([])
  })

  it('leaves a .partial- file untouched', () => {
    const { dbPath } = place()
    const partial = `${dbPath}.backup-vdrizzle-44-2026-11-05T00-00-00-000Z.partial-${randomUUID()}`
    vaultEraSnapshot(partial)
    const before = readFileSync(partial)
    expect(scrubLegacySnapshots(dbPath)).toEqual([])
    expect(readFileSync(partial).equals(before)).toBe(true)
  })

  it('leaves an unreadable snapshot and reports it', () => {
    const { dbPath } = place()
    const broken = `${dbPath}.backup-vdrizzle-45-2026-11-06T00-00-00-000Z`
    writeFileSync(broken, `not a database ${ACCOUNT_KEY}`)
    const before = readFileSync(broken)
    const [result] = scrubLegacySnapshots(dbPath)
    expect(result).toMatchObject({ path: broken, outcome: 'failed' })
    expect(result?.reason).not.toContain(ACCOUNT_KEY)
    expect(readFileSync(broken).equals(before)).toBe(true)
  })

  it('keeps the mtime retention orders by, and skips a snapshot already scrubbed', () => {
    const { dbPath } = place()
    const snapshot = `${dbPath}.backup-vdrizzle-46-2026-11-07T00-00-00-000Z`
    vaultEraSnapshot(snapshot)
    const old = new Date('2026-11-07T00:00:00.000Z')
    utimesSync(snapshot, old, old)
    const [first] = scrubLegacySnapshots(dbPath)
    expect(statSync(snapshot).mtimeMs).toBe(old.getTime())
    const after = readFileSync(snapshot)
    const [second] = scrubLegacySnapshots(dbPath, { done: first?.stamp ? [first.stamp] : [] })
    expect(second?.outcome).toBe('already-scrubbed')
    expect(readFileSync(snapshot).equals(after)).toBe(true)
  })

  it('refuses without room for a copy, leaving the snapshot', () => {
    const { dbPath } = place()
    const snapshot = `${dbPath}.backup-vdrizzle-47-2026-11-08T00-00-00-000Z`
    vaultEraSnapshot(snapshot)
    const before = readFileSync(snapshot)
    const [result] = scrubLegacySnapshots(dbPath, { freeBytes: () => 0 })
    expect(result?.outcome).toBe('failed')
    expect(readFileSync(snapshot).equals(before)).toBe(true)
  })

  it('counts the tries of a snapshot that fails, and gives it up after the last one (POD-7252)', () => {
    const { dbPath } = place()
    const snapshot = `${dbPath}.backup-vdrizzle-48-2026-11-09T00-00-00-000Z`
    vaultEraSnapshot(snapshot)
    let failures: SnapshotFailure[] = []
    for (let attempt = 1; attempt <= SNAPSHOT_SCRUB_ATTEMPTS; attempt += 1) {
      const [result] = scrubLegacySnapshots(dbPath, { freeBytes: () => 0, failures })
      expect(result).toMatchObject({ outcome: 'failed', failure: { attempts: attempt } })
      failures = result?.failure ? [result.failure] : []
    }
    expect(planSnapshotScrub(dbPath, { failures })).toMatchObject({
      toScrub: [],
      unclean: [snapshot],
    })
    // Room or not, a given-up snapshot is not opened again while it is the same file.
    const before = readFileSync(snapshot)
    const [given] = scrubLegacySnapshots(dbPath, { failures })
    expect(given).toMatchObject({
      outcome: 'given-up',
      failure: { attempts: SNAPSHOT_SCRUB_ATTEMPTS },
    })
    expect(readFileSync(snapshot).equals(before)).toBe(true)
    // A different file at that path is a new snapshot, tried again.
    utimesSync(snapshot, new Date('2026-11-10T00:00:00Z'), new Date('2026-11-10T00:00:00Z'))
    expect(planSnapshotScrub(dbPath, { failures }).toScrub).toEqual([snapshot])
  })

  it('leaves alone a snapshot written after the last clean compaction (POD-7252)', () => {
    const { dbPath } = place()
    const older = `${dbPath}.backup-vdrizzle-49-2026-11-10T00-00-00-000Z`
    const newer = `${dbPath}.backup-vdrizzle-50-2026-11-11T00-00-00-000Z`
    vaultEraSnapshot(older)
    vaultEraSnapshot(newer)
    utimesSync(older, new Date('2026-11-10T00:00:00Z'), new Date('2026-11-10T00:00:00Z'))
    utimesSync(newer, new Date('2026-11-11T00:00:00Z'), new Date('2026-11-11T00:00:00Z'))
    const cleanSinceMs = Date.parse('2026-11-10T12:00:00Z')
    expect(planSnapshotScrub(dbPath, { cleanSinceMs })).toMatchObject({
      toScrub: [older],
      unclean: [],
    })
    const results = scrubLegacySnapshots(dbPath, { cleanSinceMs })
    expect(results.find((r) => r.path === newer)?.outcome).toBe('clean-copy')
    expect(results.find((r) => r.path === older)?.outcome).toBe('scrubbed')
    expect(heldIn(fileBytes(older))).toEqual([])
  })

  it('finds an old value the scrub left, wherever it sits in a large file', () => {
    const { dbPath } = place()
    const snapshot = `${dbPath}.backup-vdrizzle-51-2026-11-12T00-00-00-000Z`
    vaultEraSnapshot(snapshot)
    // Well past the 4 MiB the search reads at a time, so the key falls across pieces.
    withDb(snapshot, (db) => {
      db.exec('CREATE TABLE padding (v BLOB)')
      db.prepare('INSERT INTO padding VALUES (randomblob(?))').run(5 * 1024 * 1024)
      db.prepare('INSERT INTO padding VALUES (?)').run(`kept-${API_KEY}`)
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    })
    const [result] = scrubLegacySnapshots(dbPath)
    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'an old value is still in the scrubbed copy',
    })
  })
})
