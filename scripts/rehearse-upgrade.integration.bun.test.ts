import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../packages/runtime/src/sqlite'
import { mintUpdateSigningKey } from '../packages/runtime/src/update-signing-key'
import { identityShapes, writeIdentityShape, serverReleaseMigrations, serverRows } from '../packages/runtime/src/fixtures/customer-upgrade'
import { DRIZZLE_MIGRATIONS } from '../apps/server/src/migrations/drizzle-manifest.generated'
import { runDrizzleMigrations } from '../apps/server/src/migrations'
import { rehearse, rehearsalEnvironment } from './rehearse-upgrade'

const root = mkdtempSync(join(tmpdir(), 'podium-rehearsal-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('upgrade rehearsal', () => {
  it('boots the candidate against a copy, fences session traffic and leaves the source untouched', async () => {
    const source = join(root, 'source')
    mkdirSync(source)
    writeIdentityShape(source, identityShapes[0]!)
    writeFileSync(join(source, 'update-signing-key.json'), JSON.stringify(mintUpdateSigningKey()))
    writeFileSync(join(source, 'config.json'), JSON.stringify({ mode: 'all-in-one', connect: { enabled: true } }))
    const db = openDatabase(join(source, 'podium.db'))
    try {
      const shipped = new Set(serverReleaseMigrations.migrations)
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.filter((m) => shipped.has(m.name)))
      for (const [table, rows] of [['machines', serverRows.machines], ['sessions', serverRows.sessions]] as const) {
        for (const row of rows) {
          const keys = Object.keys(row)
          db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row))
        }
      }
    } finally { db.close() }
    const names = readdirSync(source).sort()
    const hashes = () => Object.fromEntries(names.map((name) => [name, createHash('sha256').update(readFileSync(join(source, name))).digest('hex')]))
    const before = hashes()
    symlinkSync(source, join(source, 'live-state-link'))
    const output = await rehearse(source, join(root, 'copy')).catch((error) => {
      const log = readFileSync(join(root, 'copy', 'boot.log'), 'utf8')
      throw new Error(`${String(error)}\n${log}`, { cause: error })
    })
    expect(hashes()).toEqual(before)
    expect(readdirSync(source).sort()).toEqual([...names, 'live-state-link'].sort())
    expect(readdirSync(join(output, 'state'))).not.toContain('live-state-link')
    expect(JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'))).toMatchObject({ healthy: true, sessionTrafficDisabled: true })
    const copied = openDatabase(join(output, 'state', 'podium.db'), { readOnly: true })
    try {
      expect(copied.prepare('SELECT count(*) AS n FROM machines').get()).toEqual({ n: serverRows.machines.length })
      expect(copied.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual(serverRows.sessions.map((s) => ({ id: s.id })).sort((a, b) => a.id.localeCompare(b.id)))
    } finally { copied.close() }
    const env = rehearsalEnvironment(output)
    expect(env.PODIUM_SESSION_ID).toBeUndefined()
    expect(env.PODIUM_SUPERVISOR_MACHINE_ID).toBeUndefined()
    expect(env.PODIUM_CONNECT).toBe('off')
    expect(env.XDG_RUNTIME_DIR).toBe(join(output, 'runtime'))
    await expect(rehearse(source, join(source, 'unsafe'))).rejects.toThrow('outside')
  }, 120_000)
})
