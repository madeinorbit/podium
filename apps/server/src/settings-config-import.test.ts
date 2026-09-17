import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetConfig } from '@podium/runtime/config'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importConfigSettings, SETTINGS_CONFIG_IMPORT } from './settings-config-import'
import { openTestStore } from './test-support/open-test-store'
import { InstanceService } from './modules/instance/service'

const roots: string[] = []
const dbs: SqlDatabase[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'settings-import-'))
  roots.push(root)
  const db = openDatabase(':memory:')
  dbs.push(db)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return { root, db, path: join(root, 'config.json') }
}
function settings(db: SqlDatabase) {
  return JSON.parse(
    (db.prepare("SELECT value FROM meta WHERE key = 'settings'").get() as { value: string }).value,
  )
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('one-time config settings import', () => {
  it('moves populated UI settings, preserves bootstrap/operator/unknown fields, and never consumes later overrides', () => {
    const { root, db, path } = fixture()
    const config = {
      mode: 'server',
      port: 19991,
      publicUrl: 'https://podium.test',
      pairCode: 'kept',
      futureField: 'preserved',
      updateChannel: 'dev',
      auth: { openMode: true, mode: 'local' },
      transcriptLake: 'off',
      connect: { enabled: false, baseUrl: 'https://connect.test' },
      telemetry: {
        usage: 'on',
        crash: 'off',
        installId: '2b170e96-009a-4adb-8ff9-65dbf5b243fe',
        since: 123,
        endpoint: 'https://pulse.test',
      },
    }
    writeFileSync(path, JSON.stringify(config))
    importConfigSettings(db, root)
    expect(settings(db)).toMatchObject({
      deployment: {
        updateChannel: 'dev',
        authOpenMode: true,
        connectEnabled: false,
        telemetryUsage: 'on',
        telemetryCrash: 'off',
        telemetryInstallId: '2b170e96-009a-4adb-8ff9-65dbf5b243fe',
        telemetrySince: 123,
      },
      transcripts: { mirror: false },
    })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mode: 'server',
      port: 19991,
      publicUrl: 'https://podium.test',
      pairCode: 'kept',
      futureField: 'preserved',
      auth: { mode: 'local' },
      connect: { baseUrl: 'https://connect.test' },
      telemetry: { endpoint: 'https://pulse.test' },
    })
    writeFileSync(path, JSON.stringify({ mode: 'server', updateChannel: 'edge' }))
    importConfigSettings(db, root)
    expect(settings(db).deployment.updateChannel).toBe('dev')
    expect(JSON.parse(readFileSync(path, 'utf8')).updateChannel).toBe('edge')
  })
  it('preserves existing table choices and personal preferences', () => {
    const { root, db, path } = fixture()
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(
      'settings',
      JSON.stringify({ deployment: { updateChannel: 'stable' }, transcripts: { mirror: true } }),
    )
    db.exec(
      "CREATE TABLE user_preferences (user_id TEXT, value TEXT); INSERT INTO user_preferences VALUES ('member', 'untouched')",
    )
    writeFileSync(path, JSON.stringify({ updateChannel: 'edge', transcriptLake: 'off' }))
    importConfigSettings(db, root)
    expect(settings(db).deployment.updateChannel).toBe('stable')
    expect(settings(db).transcripts.mirror).toBe(true)
    expect(db.prepare('SELECT value FROM user_preferences').get()).toEqual({ value: 'untouched' })
  })
  it('resumes cleanup after a committed import without importing again', () => {
    const { root, db, path } = fixture()
    const raw = JSON.stringify({ updateChannel: 'edge', port: 19991 })
    writeFileSync(path, raw)
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(
      'settings',
      JSON.stringify({ deployment: { updateChannel: 'dev' } }),
    )
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(
      SETTINGS_CONFIG_IMPORT,
      JSON.stringify({ raw }),
    )
    importConfigSettings(db, root)
    expect(settings(db).deployment.updateChannel).toBe('dev')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ port: 19991 })
  })
  it('refuses malformed config without committing an import receipt', () => {
    const { root, db, path } = fixture()
    writeFileSync(path, '{broken')
    expect(() => importConfigSettings(db, root)).toThrow()
    expect(db.prepare('SELECT * FROM meta').all()).toEqual([])
  })
  it('UI writes reach the existing row and synchronous consumers, survive reopen, and leave the file unchanged', async () => {
    const { root, path } = fixture()
    const raw = JSON.stringify({ mode: 'server', port: 19991 })
    writeFileSync(path, raw)
    vi.stubEnv('PODIUM_STATE_DIR', root)
    let store = await openTestStore(join(root, 'podium.db'))
    try {
      const before = readFileSync(path, 'utf8')
      const service = new InstanceService({ settings: store.settings })
      await service.setChannel('edge')
      await service.setConsent({ usage: 'on', crash: 'off' })
      await store.settings.updateDeployment({ connectEnabled: false })
      expect(store.settings.resolve('updateChannel')).toEqual({ value: 'edge', source: 'settings' })
      expect(store.settings.resolve('connectEnabled')).toEqual({ value: false, source: 'settings' })
      expect(service.telemetryState()).toMatchObject({
        usage: 'on',
        crash: 'off',
        installId: expect.any(String),
      })
      expect(readFileSync(path, 'utf8')).toBe(before)
      await expect(
        store.transact(async () => {
          await store.settings.updateDeployment({ updateChannel: 'dev' })
          expect(store.settings.resolve('updateChannel').value).toBe('edge')
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      expect(store.settings.resolve('updateChannel').value).toBe('edge')
      expect((await store.settings.getSettings()).deployment.updateChannel).toBe('edge')
      const storedId = (await store.settings.getSettings()).deployment.telemetryInstallId
      writeFileSync(
        path,
        JSON.stringify({
          mode: 'server',
          telemetry: { installId: '2b170e96-009a-4adb-8ff9-65dbf5b243fe' },
        }),
      )
      forgetConfig(path)
      expect(service.provenance().telemetryInstallId).toEqual({ source: 'file' })
      await expect(service.resetInstallId()).rejects.toThrow(/config.json/)
      expect((await store.settings.getSettings()).deployment.telemetryInstallId).toBe(storedId)
      writeFileSync(path, before)
      forgetConfig(path)
      await store.close()
      store = await openTestStore(join(root, 'podium.db'))
      expect(store.settings.resolve('updateChannel')).toEqual({ value: 'edge', source: 'settings' })
      expect(store.settings.telemetryConfig().telemetry.usage).toBe('on')
    } finally {
      await store.close()
    }
  })
})
