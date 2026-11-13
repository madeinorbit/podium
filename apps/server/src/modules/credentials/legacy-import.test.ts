import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asAccountId,
  asMachineId,
  asUserId,
  firstAdminMemberId,
  primeFirstAdminMember,
  type UserId,
} from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { openDatabase } from '@podium/runtime/sqlite'
import { fileKeyProvider, writeWrappedDataKey } from '@podium/runtime/vault-key'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { ACCOUNT_COMMANDS_TRPC } from '../accounts/registry'
import { importLegacyCredentials } from './legacy-import'
import { mayUse } from './may-use'
import { withSecret } from './vault'

/** Obviously fake keys. */
const ADMIN_ANTHROPIC = 'FAKE-sk-ant-legacy-admin-0001'
const ADMIN_CLAUDE_TOKEN = 'FAKE-sk-ant-oat01-legacy-admin-0002'
const MEMBER_OPENAI = 'FAKE-sk-openai-legacy-member-0003'
const MEMBER_CLAUDE_TOKEN = 'FAKE-sk-ant-oat01-legacy-member-0004'
const ORPHAN_OPENROUTER = 'FAKE-sk-or-legacy-orphan-0005'
const WORKSPACE_OPENAI = 'FAKE-sk-openai-legacy-workspace-0006'
const WORKSPACE_OPENROUTER = 'FAKE-sk-or-legacy-workspace-0007'
const UNSUPPORTED = 'FAKE-ghp-legacy-unsupported-0008'

const MEMBER = asUserId('user:legacy-member')
const SENT_TO = asMachineId('machine-sent-to')
const SENT_LATER = asMachineId('machine-sent-later')

type Row = { owner: string; type: string; legacyId: string | null; legacyKey: string | null }
const byOwnerAndId = (a: Row, b: Row): number =>
  `${a.owner}|${a.legacyId}`.localeCompare(`${b.owner}|${b.legacyId}`)

describe('importLegacyCredentials at server start', () => {
  const open: SessionStore[] = []

  afterEach(async () => {
    for (const store of open.splice(0)) await store.close()
  })

  function place() {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-import-'))
    return { dbPath: join(dir, 'podium.db'), keyPath: join(dir, 'config', 'vault.key') }
  }

  async function openAt(dbPath: string, keyPath: string): Promise<SessionStore> {
    // A store-level fixture: rows are planted directly, so no change log is
    // attached (POD-6920); the import itself runs in the boot, before one is.
    const store = await SessionStore.open(dbPath, undefined, {
      vaultKeyFile: keyPath,
      changeCapture: 'whenLogAttaches',
    })
    primeFirstAdminMember(await firstAdminMemberId(store))
    open.push(store)
    return store
  }

  async function close(store: SessionStore): Promise<void> {
    open.splice(open.indexOf(store), 1)
    await store.close()
  }

  function sql<T>(dbPath: string, run: (db: ReturnType<typeof openDatabase>) => T): T {
    const db = openDatabase(dbPath)
    try {
      return run(db)
    } finally {
      db.close()
    }
  }

  const count = (dbPath: string, query: string): number =>
    sql(dbPath, (db) => (db.prepare(query).get() as { n: number }).n)

  /**
   * The old stores as they stand before the vault: API-key and Claude-token rows of
   * two owners, a row with no owner, a send, an unsupported row, and `apiKeys.*`
   * secrets of which one repeats the first admin's `accounts` key.
   */
  async function plantLegacy(dbPath: string, keyPath: string): Promise<UserId> {
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
    const connect = (
      owner: UserId,
      accountKey: string,
      provider: string,
      kind: 'api-key' | 'oauth',
      credential: string,
    ) =>
      store.accounts.connect({
        ownerUserId: owner,
        accountKey: asAccountId(accountKey),
        provider,
        kind,
        credential,
        identity: 'masked',
        scope: 'role',
        createdAt: 1,
      })
    await connect(admin, 'managed:anthropic', 'anthropic', 'api-key', ADMIN_ANTHROPIC)
    await connect(admin, 'managed:claude-oauth', 'anthropic', 'oauth', ADMIN_CLAUDE_TOKEN)
    await connect(MEMBER, 'managed:openai', 'openai', 'api-key', MEMBER_OPENAI)
    await connect(MEMBER, 'managed:claude-oauth', 'anthropic', 'oauth', MEMBER_CLAUDE_TOKEN)
    await store.accounts.markSent(MEMBER, 'managed:openai', SENT_TO, '2026-11-01T00:00:00Z')
    const at = new Date().toISOString()
    await store.secrets.set('apiKeys.anthropic', ADMIN_ANTHROPIC, at)
    await store.secrets.set('apiKeys.openai', WORKSPACE_OPENAI, at)
    await store.secrets.set('apiKeys.openrouter', WORKSPACE_OPENROUTER, at)
    await close(store)
    // Rows the repository API cannot write: one from before connections had owners,
    // and one of a provider no credential type covers.
    sql(dbPath, (db) => {
      const insert = db.prepare(
        `INSERT INTO accounts (id, provider, kind, credential, identity, scope, created_at,
           owner_user_id, account_key, ref, shared_with)
         VALUES (?, ?, ?, ?, '', 'role', 2, ?, ?, ?, NULL)`,
      )
      insert.run(
        'managed:openrouter',
        'openrouter',
        'api-key',
        ORPHAN_OPENROUTER,
        null,
        null,
        'managed:openrouter',
      )
      insert.run('github-row', 'github', 'api-key', UNSUPPORTED, admin, 'managed:github', null)
    })
    return admin
  }

  it('moves each old key into a credential with its owner, ids and sends, and is idempotent', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantLegacy(dbPath, keyPath)

    const store = await openAt(dbPath, keyPath)
    const credentials = [
      ...(await store.credentials.listVisibleTo(admin)),
      ...(await store.credentials.listVisibleTo(MEMBER)),
    ]
    const summary: Row[] = credentials
      .map((c) => ({
        owner: c.ownerUserId,
        type: c.type,
        legacyId: c.legacyId,
        legacyKey: c.legacyKey,
      }))
      .sort(byOwnerAndId)
    const expected: Row[] = [
      {
        owner: admin,
        type: 'openai.api-key',
        legacyId: 'apiKeys.openai',
        legacyKey: 'managed:openai',
      },
      // The ownerless row moved to the first admin answers `managed:openrouter` first.
      { owner: admin, type: 'openrouter.api-key', legacyId: 'apiKeys.openrouter', legacyKey: null },
      {
        owner: admin,
        type: 'anthropic.api-key',
        legacyId: `managed:anthropic@${admin}`,
        legacyKey: 'managed:anthropic',
      },
      {
        owner: admin,
        type: 'anthropic.claude-token',
        legacyId: `managed:claude-oauth@${admin}`,
        legacyKey: 'managed:claude-oauth',
      },
      {
        owner: admin,
        type: 'openrouter.api-key',
        legacyId: 'managed:openrouter',
        legacyKey: 'managed:openrouter',
      },
      {
        owner: MEMBER,
        type: 'anthropic.claude-token',
        legacyId: `managed:claude-oauth@${MEMBER}`,
        legacyKey: 'managed:claude-oauth',
      },
      {
        owner: MEMBER,
        type: 'openai.api-key',
        legacyId: `managed:openai@${MEMBER}`,
        legacyKey: 'managed:openai',
      },
    ]
    expect(summary).toEqual(expected.sort(byOwnerAndId))
    // The repeated key (apiKeys.anthropic is the admin's accounts key) is merged.
    expect(await store.credentials.findByLegacyId('apiKeys.anthropic')).toBeUndefined()
    expect(await store.credentials.findByLegacyId('github-row')).toBeUndefined()
    expect((await store.credentials.findByLegacyKey(MEMBER, 'managed:openai'))?.legacyId).toBe(
      `managed:openai@${MEMBER}`,
    )

    // Each opens to its original value.
    const opened: Record<string, string> = {}
    for (const c of credentials) {
      opened[c.legacyId ?? c.id] = await withSecret(store, c.id, async (secret) => secret)
    }
    expect(opened).toEqual({
      'apiKeys.openai': WORKSPACE_OPENAI,
      'apiKeys.openrouter': WORKSPACE_OPENROUTER,
      [`managed:anthropic@${admin}`]: ADMIN_ANTHROPIC,
      [`managed:claude-oauth@${admin}`]: ADMIN_CLAUDE_TOKEN,
      'managed:openrouter': ORPHAN_OPENROUTER,
      [`managed:claude-oauth@${MEMBER}`]: MEMBER_CLAUDE_TOKEN,
      [`managed:openai@${MEMBER}`]: MEMBER_OPENAI,
    })

    // The send is a machine allowance, allowed by the owner.
    const memberOpenai = await store.credentials.findByLegacyKey(MEMBER, 'managed:openai')
    expect(
      sql(dbPath, (db) =>
        db.prepare('SELECT credential_id, machine_id, allowed_by FROM credential_machines').all(),
      ),
    ).toEqual([{ credential_id: memberOpenai?.id, machine_id: SENT_TO, allowed_by: MEMBER }])

    // The unsupported row is skipped with a log line naming it, never its value.
    const log = { info: vi.fn(), warn: vi.fn() }
    const again = await importLegacyCredentials({
      secrets: store.secrets,
      users: store.users,
      credentials: store.credentials,
      grants: store.grants,
      vault: store.vault,
      log,
    })
    expect(again).toEqual({
      created: 0,
      machinesAllowed: 0,
      grantsMade: 0,
      skipped: ['github-row (github/api-key)'],
      refused: null,
    })
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('not moved'), {
      skipped: ['github-row (github/api-key)'],
    })
    // Canary for the log search: the value is findable where it is planted.
    expect(
      count(dbPath, `SELECT count(*) AS n FROM accounts WHERE credential = '${UNSUPPORTED}'`),
    ).toBe(1)
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(UNSUPPORTED)

    const ciphertexts = JSON.stringify(
      sql(dbPath, (db) => db.prepare('SELECT * FROM credential_secrets').all()),
    )
    for (const secret of [ADMIN_ANTHROPIC, MEMBER_OPENAI, ORPHAN_OPENROUTER, WORKSPACE_OPENAI]) {
      expect(ciphertexts).not.toContain(secret)
    }
    await close(store)

    // A second start creates nothing.
    await close(await openAt(dbPath, keyPath))
    expect(count(dbPath, 'SELECT count(*) AS n FROM credentials')).toBe(7)
    expect(count(dbPath, 'SELECT count(*) AS n FROM credential_secrets')).toBe(7)
    expect(count(dbPath, 'SELECT count(*) AS n FROM credential_machines')).toBe(1)

    // The old values are still present (Task 21 destroys them).
    expect(count(dbPath, 'SELECT count(*) AS n FROM accounts')).toBe(6)
    expect(
      count(dbPath, "SELECT count(*) AS n FROM server_secrets WHERE key LIKE 'apiKeys.%'"),
    ).toBe(3)
    expect(count(dbPath, 'SELECT count(*) AS n FROM account_machine_sends')).toBe(1)
  })

  /** Share the planted rows as acceptance 7 names them; returns the admin's credential ids. */
  function plantShares(dbPath: string, admin: UserId): void {
    sql(dbPath, (db) => {
      const share = db.prepare('UPDATE accounts SET shared_with = ? WHERE id = ?')
      share.run('["*"]', `managed:anthropic@${admin}`)
      share.run(JSON.stringify([MEMBER]), `managed:claude-oauth@${admin}`)
      share.run(JSON.stringify(['user:gone-6891']), `managed:openai@${MEMBER}`)
    })
  }

  const grantsOf = async (store: SessionStore, id: string) =>
    (await store.grants.listForResource('credential', id))
      .map((g) => `${g.verb} ${g.grantee} by ${g.owner}`)
      .sort()

  it('carries old shares as grants once: everyone, one person, nobody (acceptance 7)', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantLegacy(dbPath, keyPath)
    plantShares(dbPath, admin)

    const store = await openAt(dbPath, keyPath)
    const everyone = await store.credentials.findByLegacyId(`managed:anthropic@${admin}`)
    const toMember = await store.credentials.findByLegacyId(`managed:claude-oauth@${admin}`)
    const vanished = await store.credentials.findByLegacyId(`managed:openai@${MEMBER}`)
    const privateOne = await store.credentials.findByLegacyId('managed:openrouter')
    if (!everyone || !toMember || !vanished || !privateOne) throw new Error('not moved')
    expect(await grantsOf(store, everyone.id)).toEqual([`use group:all-members by ${admin}`])
    expect(await grantsOf(store, toMember.id)).toEqual([`use ${MEMBER} by ${admin}`])
    expect(await grantsOf(store, vanished.id)).toEqual([])
    expect(await grantsOf(store, privateOne.id)).toEqual([])

    // The member uses exactly what was shared with them, and their own.
    const usable = []
    for (const c of await store.credentials.listVisibleTo(admin)) {
      if (await mayUse(store, MEMBER, c)) usable.push(c.legacyId)
    }
    expect(usable.sort()).toEqual([`managed:anthropic@${admin}`, `managed:claude-oauth@${admin}`])
    await close(store)

    // A second start leaves the grants as they are.
    const second = await openAt(dbPath, keyPath)
    expect(await grantsOf(second, everyone.id)).toEqual([`use group:all-members by ${admin}`])
    expect(await grantsOf(second, toMember.id)).toEqual([`use ${MEMBER} by ${admin}`])
    expect(
      count(dbPath, "SELECT count(*) AS n FROM grants WHERE resource_kind = 'credential'"),
    ).toBe(2)
  })

  it('logs an old share with someone who no longer exists, never a value', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantLegacy(dbPath, keyPath)
    plantShares(dbPath, admin)
    const store = await openAt(dbPath, keyPath)
    // Undo the start's import so it runs again here, with a log to read.
    sql(dbPath, (db) => {
      for (const table of ['grants', 'credential_machines', 'credential_secrets', 'credentials']) {
        db.prepare(
          `DELETE FROM ${table}${table === 'grants' ? " WHERE resource_kind = 'credential'" : ''}`,
        ).run()
      }
    })
    const log = { info: vi.fn(), warn: vi.fn() }
    const result = await importLegacyCredentials({
      secrets: store.secrets,
      users: store.users,
      credentials: store.credentials,
      grants: store.grants,
      vault: store.vault,
      log,
    })
    expect(result).toMatchObject({ created: 7, machinesAllowed: 1, grantsMade: 2 })
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no longer exist'), {
      vanished: [`managed:openai@${MEMBER} → user:gone-6891`],
    })
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(MEMBER_OPENAI)
  })

  it('an unshare and a disallowed machine survive a restart', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantLegacy(dbPath, keyPath)
    plantShares(dbPath, admin)
    const store = await openAt(dbPath, keyPath)
    const everyone = await store.credentials.findByLegacyId(`managed:anthropic@${admin}`)
    const sent = await store.credentials.findByLegacyKey(MEMBER, 'managed:openai')
    if (!everyone || !sent) throw new Error('not moved')
    expect(await store.credentials.isMachineAllowed(sent.id, SENT_TO)).toBe(true)
    expect(await store.grants.remove('credential', everyone.id, 'group:all-members', 'use')).toBe(
      true,
    )
    await store.credentials.disallowMachine(sent.id, SENT_TO)
    await close(store)

    const next = await openAt(dbPath, keyPath)
    expect(await grantsOf(next, everyone.id)).toEqual([])
    expect(await next.credentials.isMachineAllowed(sent.id, SENT_TO)).toBe(false)
  })

  /** The old command handlers, as the Settings page reaches them, over this store. */
  const accountsAs = (store: SessionStore, caller: UserId) =>
    ({
      accounts: store.accounts,
      machines: store.machines,
      machineStanding: async () => new Map([[SENT_LATER, 'use' as const]]),
      callerUserId: caller,
      credentialStore: store,
    }) as never

  it('a send made after the move through accounts.send is allowed at once', async () => {
    const { dbPath, keyPath } = place()
    await plantLegacy(dbPath, keyPath)
    const store = await openAt(dbPath, keyPath)
    const credential = await store.credentials.findByLegacyKey(MEMBER, 'managed:openai')
    if (!credential) throw new Error('the member key was not moved')
    expect(await store.credentials.isMachineAllowed(credential.id, SENT_LATER)).toBe(false)
    await ACCOUNT_COMMANDS_TRPC.send.handler(accountsAs(store, MEMBER), {
      id: 'managed:openai',
      machineId: SENT_LATER,
      acknowledgeSharedMachine: true,
    } as never)
    expect(await store.credentials.isMachineAllowed(credential.id, SENT_LATER)).toBe(true)
  })

  it('an unshare and an unsend through accounts.* survive a restart', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantLegacy(dbPath, keyPath)
    plantShares(dbPath, admin)
    const store = await openAt(dbPath, keyPath)
    const everyone = await store.credentials.findByLegacyId(`managed:anthropic@${admin}`)
    const sent = await store.credentials.findByLegacyKey(MEMBER, 'managed:openai')
    if (!everyone || !sent) throw new Error('not moved')
    await ACCOUNT_COMMANDS_TRPC.share.handler(accountsAs(store, admin), {
      id: 'managed:anthropic',
      everyone: false,
      users: [],
    } as never)
    await ACCOUNT_COMMANDS_TRPC.unsend.handler(accountsAs(store, MEMBER), {
      id: 'managed:openai',
      machineId: SENT_TO,
    } as never)
    expect(await grantsOf(store, everyone.id)).toEqual([])
    expect(await store.credentials.isMachineAllowed(sent.id, SENT_TO)).toBe(false)
    await close(store)

    const next = await openAt(dbPath, keyPath)
    expect(await grantsOf(next, everyone.id)).toEqual([])
    expect(await next.credentials.isMachineAllowed(sent.id, SENT_TO)).toBe(false)
  })

  it('imports nothing while the vault is locked, and imports on the next start with the key', async () => {
    const { dbPath, keyPath } = place()
    const admin = await plantLegacy(dbPath, keyPath)
    // A data key exists (wrapped under the key file), and the key file is set aside.
    const db = openDatabase(dbPath)
    await writeWrappedDataKey(db, await fileKeyProvider(keyPath), randomBytes(32))
    db.close()
    const setAside = `${keyPath}.set-aside`
    renameSync(keyPath, setAside)

    const locked = await openAt(dbPath, keyPath)
    expect(locked.vault.state()).toBe('locked')
    await close(locked)
    expect(count(dbPath, 'SELECT count(*) AS n FROM credentials')).toBe(0)
    expect(existsSync(keyPath)).toBe(false)

    renameSync(setAside, keyPath)
    const unlocked = await openAt(dbPath, keyPath)
    expect(unlocked.vault.state()).toBe('ready')
    expect(await unlocked.credentials.listVisibleTo(admin)).toHaveLength(5)
  })
})
