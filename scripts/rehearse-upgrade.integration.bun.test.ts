import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDrizzleMigrations } from '../apps/server/src/migrations'
import { DRIZZLE_MIGRATIONS } from '../apps/server/src/migrations/drizzle-manifest.generated'
import { seedCustomerMembers } from '../apps/server/src/test-support/customer-upgrade-database'
import { hashPassword, verifyPasswordHash } from '../packages/runtime/src/auth-store'
import {
  identityShapes,
  serverReleaseMigrations,
  serverRows,
  writeIdentityShape,
} from '../packages/runtime/src/fixtures/customer-upgrade'
import { openDatabase, type SqlDatabase } from '../packages/runtime/src/sqlite'
import { mintUpdateSigningKey } from '../packages/runtime/src/update-signing-key'
import {
  copyRehearsalState,
  DEFAULT_BOOT_TIMEOUT_MS,
  rehearsalEnvironment,
  rehearse,
} from './rehearse-upgrade'

const root = mkdtempSync(join(tmpdir(), 'podium-rehearsal-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function ownership(db: SqlDatabase) {
  return {
    members: db
      .prepare('SELECT id, email, role, disabled_at, authz_generation FROM users ORDER BY id')
      .all(),
    sessions: db
      .prepare('SELECT id, owner_user_id, created_by_on_behalf_of FROM sessions ORDER BY id')
      .all(),
    tasks: db
      .prepare(
        'SELECT id, owner_user_id, created_by_on_behalf_of, assignee FROM issues ORDER BY id',
      )
      .all(),
    custody: db
      .prepare(
        "SELECT resource_id, grantee, owner FROM grants WHERE resource_kind = 'machine' AND custody = 1 ORDER BY resource_id",
      )
      .all(),
    machineKeys: db.prepare('SELECT id, token_hash, public_key FROM machines ORDER BY id').all(),
    providerKeys: db
      .prepare('SELECT id, owner_user_id, credential FROM accounts ORDER BY id')
      .all(),
    logins: db.prepare('SELECT * FROM client_sessions ORDER BY token_hash').all(),
  }
}

describe('upgrade rehearsal', () => {
  it('snapshots committed WAL pages without copying credentials, backups or unrelated state', () => {
    const source = join(root, 'wal-source')
    mkdirSync(source)
    const db = openDatabase(join(source, 'podium.db'))
    try {
      db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof (id INTEGER PRIMARY KEY); INSERT INTO proof VALUES (42)',
      )
      writeFileSync(join(source, 'auth.json'), 'private-source-credential')
      writeFileSync(join(source, 'podium.db.backup-old'), 'old-backup')
      mkdirSync(join(source, 'transcripts'))
      writeFileSync(join(source, 'transcripts', 'private.txt'), 'private-transcript')
      const output = join(root, 'wal-copy')
      copyRehearsalState(source, output)
      expect(readdirSync(output)).toEqual(['podium.db'])
      const copy = openDatabase(join(output, 'podium.db'), { readOnly: true })
      try {
        expect(copy.prepare('SELECT id FROM proof').all()).toEqual([{ id: 42 }])
      } finally {
        copy.close()
      }
      expect(db.prepare('SELECT id FROM proof').all()).toEqual([{ id: 42 }])
    } finally {
      db.close()
    }
  })

  it('records a configurable timeout and child signal on failure', async () => {
    const source = join(root, 'timeout-source')
    mkdirSync(source)
    const db = openDatabase(join(source, 'podium.db'))
    db.exec('CREATE TABLE proof (id INTEGER PRIMARY KEY)')
    db.close()
    await expect(rehearse(source, join(root, 'timeout-copy'), { timeoutMs: 1 })).rejects.toThrow(
      'timedOut true',
    )
    const report = JSON.parse(readFileSync(join(root, 'timeout-copy', 'rehearsal.json'), 'utf8'))
    expect(report).toMatchObject({
      healthy: false,
      timedOut: true,
      timeoutMs: 1,
      exitCode: null,
      signal: 'SIGKILL',
    })
    expect(report.bootMs).toBeGreaterThanOrEqual(1)
    await expect(
      rehearse(source, join(root, 'invalid-timeout'), { timeoutMs: NaN }),
    ).rejects.toThrow('timeout')
  })

  it('boots the candidate against a copy, fences session traffic and leaves the source untouched', async () => {
    const source = join(root, 'source')
    mkdirSync(source)
    writeIdentityShape(source, identityShapes[0]!)
    writeFileSync(join(source, 'update-signing-key.json'), JSON.stringify(mintUpdateSigningKey()))
    writeFileSync(
      join(source, 'config.json'),
      JSON.stringify({ mode: 'all-in-one', connect: { enabled: true } }),
    )
    const db = openDatabase(join(source, 'podium.db'))
    try {
      const shipped = new Set(serverReleaseMigrations.migrations)
      runDrizzleMigrations(
        db,
        DRIZZLE_MIGRATIONS.filter((m) => shipped.has(m.name)),
      )
      for (const [table, rows] of [
        ['machines', serverRows.machines],
        ['sessions', serverRows.sessions],
      ] as const) {
        for (const row of rows) {
          const keys = Object.keys(row)
          db.prepare(
            `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          ).run(...Object.values(row))
        }
      }
    } finally {
      db.close()
    }
    const names = readdirSync(source).sort()
    const hashes = () =>
      Object.fromEntries(
        names.map((name) => [
          name,
          createHash('sha256')
            .update(readFileSync(join(source, name)))
            .digest('hex'),
        ]),
      )
    const before = hashes()
    symlinkSync(source, join(source, 'live-state-link'))
    const output = await rehearse(source, join(root, 'copy')).catch((error) => {
      const log = readFileSync(join(root, 'copy', 'boot.log'), 'utf8')
      throw new Error(`${String(error)}\n${log}`, { cause: error })
    })
    expect(hashes()).toEqual(before)
    expect(readdirSync(source).sort()).toEqual([...names, 'live-state-link'].sort())
    expect(readdirSync(join(output, 'state'))).not.toContain('live-state-link')
    expect(JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'))).toMatchObject({
      healthy: true,
      sessionTrafficDisabled: true,
    })
    const report = JSON.parse(readFileSync(join(output, 'rehearsal.json'), 'utf8'))
    expect(report).toMatchObject({
      healthy: true,
      exitCode: 0,
      timedOut: false,
      timeoutMs: DEFAULT_BOOT_TIMEOUT_MS,
    })
    expect(report.timeoutMs).toBeGreaterThan(132_500)
    expect(report.snapshotBytes).toBeGreaterThan(0)
    expect(report.sourceBytes).toBeGreaterThanOrEqual(report.snapshotBytes)
    expect(report.totalMs).toBeGreaterThanOrEqual(report.bootMs + report.snapshotMs)
    expect(report.migrationMs).toBeGreaterThanOrEqual(0)
    expect(report.candidateCommit).toMatch(/^[a-f0-9]{40}$/)
    const stages = JSON.parse(readFileSync(join(output, 'boot-stages.json'), 'utf8')) as {
      stage: string
      durationMs: number
      stageDurationMs: number
    }[]
    for (const stage of [
      'store open',
      'backup',
      'migrations',
      'imports',
      'backfill',
      'planner statistics',
      'sessions recovery',
      'issues catch-up',
      'queued messages recovery',
      'setup enrollment',
      'machines updates adoption',
      'listen',
      'health exposed',
    ]) {
      expect(
        stages.some((row) => row.stage === stage && row.durationMs >= row.stageDurationMs),
      ).toBe(true)
    }
    const copied = openDatabase(join(output, 'state', 'podium.db'), { readOnly: true })
    try {
      expect(copied.prepare('SELECT count(*) AS n FROM machines').get()).toEqual({
        n: serverRows.machines.length,
      })
      expect(copied.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual(
        serverRows.sessions.map((s) => ({ id: s.id })).sort((a, b) => a.id.localeCompare(b.id)),
      )
    } finally {
      copied.close()
    }
    const env = rehearsalEnvironment(output)
    expect(env.PODIUM_SESSION_ID).toBeUndefined()
    expect(env.PODIUM_SUPERVISOR_MACHINE_ID).toBeUndefined()
    expect(env.PODIUM_CONNECT).toBe('off')
    expect(env.XDG_RUNTIME_DIR).toBe(join(output, 'runtime'))
    await expect(rehearse(source, join(source, 'unsafe'))).rejects.toThrow('outside')
  }, 120_000)

  for (const multiple of [false, true]) {
    it(`carries passwords and ownership through the ${multiple ? 'multi' : 'single'}-member customer fixture`, async () => {
      const source = join(root, `member-source-${multiple}`)
      mkdirSync(source)
      const sourcePath = join(source, 'podium.db')
      const db = openDatabase(sourcePath)
      const credentials = new Map<string, { password: string; hash: string }>()
      let before: ReturnType<typeof ownership>
      try {
        seedCustomerMembers(db, multiple)
        // Establish the state after the earlier ownership repairs, just before the identity tables.
        const cut = DRIZZLE_MIGRATIONS.findIndex(({ name }) => name.endsWith('_identity-core'))
        expect(cut).toBeGreaterThan(0)
        runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, cut))
        expect(
          db.prepare("SELECT name FROM sqlite_schema WHERE name = 'identity_membership'").get(),
        ).toBeUndefined()
        const fixtureMembers: [string, string][] = [['mem_upgrade_alice', 'alice']]
        if (multiple) fixtureMembers.push(['mem_upgrade_bob', 'bob'])
        for (const [id, name] of fixtureMembers) {
          const password = `${name}-legacy-fixture-password`
          const hash = await hashPassword(password)
          db.prepare('UPDATE user_credentials SET password_hash = ? WHERE user_id = ?').run(
            hash,
            id,
          )
          if (multiple)
            db.prepare('UPDATE users SET email = ? WHERE id = ?').run(`${name}@example.test`, id)
          credentials.set(id, { password, hash })
        }
        before = ownership(db)
        expect(before.tasks.length).toBeGreaterThan(0)
        expect(before.machineKeys.length).toBeGreaterThan(0)
        expect(before.providerKeys).toEqual([
          {
            id: 'managed:anthropic',
            owner_user_id: 'mem_upgrade_alice',
            credential: 'fixture-only-provider-key',
          },
        ])
        if (multiple) {
          expect(before.sessions).toContainEqual({
            id: 'session-bob-on-alice',
            owner_user_id: 'mem_upgrade_bob',
            created_by_on_behalf_of: 'mem_upgrade_bob',
          })
          expect(before.custody).toContainEqual({
            resource_id: 'machine-peer',
            grantee: 'mem_upgrade_bob',
            owner: 'mem_upgrade_bob',
          })
          expect(before.tasks).toContainEqual(
            expect.objectContaining({
              id: 'task-human-assignee',
              owner_user_id: 'mem_upgrade_bob',
            }),
          )
        }
      } finally {
        db.close()
      }
      const sourceBefore = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
      const output = await rehearse(source, join(root, `member-copy-${multiple}`))
      expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(sourceBefore)
      const upgraded = openDatabase(join(output, 'state', 'podium.db'), { readOnly: true })
      try {
        expect(upgraded.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
          n: DRIZZLE_MIGRATIONS.length,
        })
        expect(upgraded.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
        expect(ownership(upgraded)).toEqual(before)
        const memberships = upgraded
          .prepare(`
        SELECT m.member_id, m.role, m.status, a.password
        FROM identity_membership m LEFT JOIN identity_account a ON a.user_id = m.account_id
        ORDER BY m.member_id`)
          .all() as { member_id: string; role: string; status: string; password: string | null }[]
        expect(memberships.map(({ password: _password, ...membership }) => membership)).toEqual([
          { member_id: 'mem_upgrade_alice', role: 'admin', status: 'active' },
          ...(multiple
            ? [
                { member_id: 'mem_upgrade_bob', role: 'member', status: 'active' },
                { member_id: 'mem_upgrade_carol', role: 'member', status: 'disabled' },
              ]
            : []),
        ])
        for (const row of memberships) {
          const credential = credentials.get(row.member_id)
          expect(row.password).toBe(credential?.hash ?? null)
          if (credential && row.password)
            expect(await verifyPasswordHash(credential.password, row.password)).toBe(true)
        }
        expect(upgraded.prepare('SELECT id FROM identity_session').all()).toEqual([])
      } finally {
        upgraded.close()
      }
    }, 120_000)
  }
})
