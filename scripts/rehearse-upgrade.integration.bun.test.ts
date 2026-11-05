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
import {
  identityShapes,
  serverReleaseMigrations,
  serverRows,
  writeIdentityShape,
} from '../packages/runtime/src/fixtures/customer-upgrade'
import { openDatabase } from '../packages/runtime/src/sqlite'
import { mintUpdateSigningKey } from '../packages/runtime/src/update-signing-key'
import {
  copyRehearsalState,
  DEFAULT_BOOT_TIMEOUT_MS,
  rehearsalEnvironment,
  rehearse,
} from './rehearse-upgrade'

const root = mkdtempSync(join(tmpdir(), 'podium-rehearsal-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

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
})
