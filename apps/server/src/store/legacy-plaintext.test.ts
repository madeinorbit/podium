/**
 * The keys stored in plain text before the vault are destroyed once moved
 * (credential management design §7, "Old plaintext is destroyed"; plan Task 21).
 *
 * Every test plants obviously fake old values into a database as a version
 * before the vault left it, starts the server's store on it, and reads the raw
 * rows and the bytes of the database file and its sidecars.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSink, createRingBufferSink } from '@podium/logger'
import { asUserId, firstAdminMemberId, primeFirstAdminMember, type UserId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../store'
import { newCredentialId } from './credentials'
import { memberFacts } from './fixtures/test-support'
import { LEGACY_PLAINTEXT_STATE_KEY, type LegacyPlaintextOptions } from './legacy-plaintext'

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

/** Every planted value, as the bytes a search looks for. */
const PLANTED = [
  ACCOUNT_KEY,
  CLAUDE_TOKEN,
  ...Object.values(API_KEYS),
  LINEAR,
  TELEGRAM,
  LOGIN_FILE_BASE64,
]

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

const secretKeys = (dbPath: string) =>
  (
    sql(dbPath, (db) => db.prepare('SELECT key FROM server_secrets ORDER BY key').all()) as {
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
        `INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at,
           owner_user_id, account_key, ref, shared_with)
         VALUES (?, ?, ?, ?, '', 'role', ?, ?, ?, NULL, NULL)`,
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
        `INSERT INTO account_machine_sends (account_id, machine_id, sent_at) VALUES (?, 'm-sent', '2026-11-01T00:00:00Z')`,
      ).run(`managed:openai@${MEMBER}`)
      const secret = db.prepare(
        'INSERT OR REPLACE INTO server_secrets (key, value, updated_at) VALUES (?, ?, ?)',
      )
      for (const [key, value] of Object.entries(API_KEYS))
        secret.run(key, value, '2026-01-01T00:00:00.000Z')
      secret.run('integrations.linearApiKey', LINEAR, '2026-01-01T00:00:00.000Z')
      secret.run('notifications.telegramBotToken', TELEGRAM, '2026-01-01T00:00:00.000Z')
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
      expect(store.legacyPlaintextReport?.leftInPlace).toEqual([`managed:anthropic@${admin}`])
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
    expect(store.legacyPlaintextReport?.destroyed).toBe(0)
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
    expect(store.legacyPlaintextReport?.leftInPlace).toEqual([])
    await close(store)
    expect(accountRows(dbPath)).toEqual([])
  })

  it('a second start does nothing', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath)
    const first = await openAt(dbPath, keyPath)
    expect(first.legacyPlaintextReport?.ran).toBe(true)
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
    reader.prepare('SELECT count(*) FROM server_secrets').get()
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
    expect(store.legacyPlaintextReport?.compaction).toBe('clean')
    expect(heldIn(databaseBytes(dbPath))).toEqual([])
  })

  it('a checkpoint busy at every try stays pending, and the next start finishes it', async () => {
    const { dbPath, keyPath } = place()
    await plantOldDatabase(dbPath, keyPath, { transferRow: false })
    const reader = openDatabase(dbPath)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM server_secrets').get()
    const first = await openAt(dbPath, keyPath, { attempts: 3, wait: () => {} })
    expect(first.legacyPlaintextReport?.compaction).toBe('busy')
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
